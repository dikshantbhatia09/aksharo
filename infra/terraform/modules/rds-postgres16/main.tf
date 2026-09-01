# ---------------------------------------------------------------------------
# rds-postgres16 — encrypted PostgreSQL 16 with point-in-time recovery, a
# parameter group that loads pg_stat_statements, and an optional read replica.
#
# THREAT-MODEL T24: the instance is created in the caller's (residency) region
# and never replicated across one.
# THREAT-MODEL T21: no password is ever written to Terraform state. RDS manages
# the master credential in Secrets Manager and rotates it; the bootstrap script
# copies it into the SSM parameter that the applications read.
# ---------------------------------------------------------------------------

locals {
  tags = merge(var.tags, { "montaj:module" = "rds-postgres16" })

  # pg_stat_statements is required by the query-latency panels in
  # infra/observability/dashboards and by the slow-query section of the deploy
  # runbook. shared_preload_libraries only takes effect on reboot.
  default_parameters = {
    shared_preload_libraries = {
      value        = "pg_stat_statements"
      apply_method = "pending-reboot"
    }
    "pg_stat_statements.track" = {
      value        = "all"
      apply_method = "immediate"
    }
    "pg_stat_statements.max" = {
      value        = "10000"
      apply_method = "pending-reboot"
    }
    "pg_stat_statements.save" = {
      value        = "1"
      apply_method = "immediate"
    }
    track_activity_query_size = {
      value        = "4096"
      apply_method = "pending-reboot"
    }
    track_io_timing = {
      value        = "1"
      apply_method = "immediate"
    }
    # Anything slower than a second is a bug worth a log line, not noise.
    log_min_duration_statement = {
      value        = "1000"
      apply_method = "immediate"
    }
    log_lock_waits = {
      value        = "1"
      apply_method = "immediate"
    }
    # Reject non-TLS connections outright rather than trusting every client to
    # ask for TLS.
    "rds.force_ssl" = {
      value        = "1"
      apply_method = "pending-reboot"
    }
    log_statement = {
      value        = "ddl"
      apply_method = "immediate"
    }
    idle_in_transaction_session_timeout = {
      value        = "60000"
      apply_method = "immediate"
    }

    # pgvector. A03's first migration opens with `CREATE EXTENSION IF NOT
    # EXISTS vector` because `audio_assets.embedding` is `vector(512)` with an
    # HNSW index (decision D44). pgvector is a plain extension on RDS
    # PostgreSQL 15.2+ — it needs no shared_preload_libraries entry — so the
    # only thing managed Postgres requires is that `vector` is on the
    # rds.allowed_extensions list below.
    "rds.allowed_extensions" = {
      value        = join(",", var.allowed_extensions)
      apply_method = "pending-reboot"
    }

    # HNSW index builds are memory-hungry; a build that spills to disk turns
    # minutes into hours.
    maintenance_work_mem = {
      value        = tostring(var.hnsw_maintenance_work_mem_kb)
      apply_method = "immediate"
    }
  }

  parameters = merge(local.default_parameters, var.parameters)
}

resource "aws_db_subnet_group" "this" {
  name        = var.name
  description = "${var.name} database tier"
  subnet_ids  = var.database_subnet_ids

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_security_group" "this" {
  name        = "${var.name}-postgres"
  description = "PostgreSQL 16 for ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(local.tags, { Name = "${var.name}-postgres" })
}

resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each = toset(var.allowed_security_group_ids)

  security_group_id            = aws_security_group.this.id
  description                  = "PostgreSQL from ${each.value}"
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# No egress rule: the database never initiates an outbound connection.

resource "aws_kms_key" "this" {
  description             = "${var.name} PostgreSQL storage and Performance Insights encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = local.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}-postgres"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.name}-postgres16"
  family      = "postgres16"
  description = "${var.name} PostgreSQL 16 with pg_stat_statements"

  dynamic "parameter" {
    for_each = local.parameters

    content {
      name         = parameter.key
      value        = parameter.value.value
      apply_method = parameter.value.apply_method
    }
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

data "aws_iam_policy_document" "monitoring_assume" {
  count = var.monitoring_interval_seconds > 0 ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  count = var.monitoring_interval_seconds > 0 ? 1 : 0

  name               = "${var.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume[0].json

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count = var.monitoring_interval_seconds > 0 ? 1 : 0

  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = var.database_name
  username = var.master_username

  # The password lives in an AWS-managed, AWS-rotated Secrets Manager secret.
  # Terraform never sees it, so it never lands in state or in a plan output.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this.arn

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb > 0 ? var.max_allocated_storage_gb : null
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = var.multi_az
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # Point-in-time recovery: automated backups plus transaction logs give any
  # second inside the retention window. See docs/runbooks/restore-from-pitr.md.
  backup_retention_period   = var.backup_retention_days
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  deletion_protection       = var.deletion_protection

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.this.arn
  performance_insights_retention_period = var.performance_insights_retention_days
  monitoring_interval                   = var.monitoring_interval_seconds
  monitoring_role_arn                   = var.monitoring_interval_seconds > 0 ? aws_iam_role.monitoring[0].arn : null

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = merge(local.tags, { Name = var.name })

  lifecycle {
    # timestamp() in final_snapshot_identifier would otherwise force a diff on
    # every plan.
    ignore_changes = [final_snapshot_identifier]
  }
}

resource "aws_db_instance" "replica" {
  count = var.create_read_replica ? 1 : 0

  identifier          = "${var.name}-replica"
  replicate_source_db = aws_db_instance.this.identifier
  instance_class      = var.read_replica_instance_class != "" ? var.read_replica_instance_class : var.instance_class

  storage_encrypted = true
  kms_key_id        = aws_kms_key.this.arn

  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # A replica keeps no backups of its own; it is not a recovery point.
  backup_retention_period = 0
  skip_final_snapshot     = true
  deletion_protection     = var.deletion_protection

  auto_minor_version_upgrade = true
  apply_immediately          = false

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.this.arn
  monitoring_interval             = var.monitoring_interval_seconds
  monitoring_role_arn             = var.monitoring_interval_seconds > 0 ? aws_iam_role.monitoring[0].arn : null

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = merge(local.tags, { Name = "${var.name}-replica" })
}
