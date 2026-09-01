# ---------------------------------------------------------------------------
# elasticache-redis7 — Redis 7 replication group for BullMQ queues, the
# WebSocket pub/sub fan-out and the session cache.
#
# The parameter group is not decoration. BullMQ stores job state in Redis keys
# with no TTL; under any eviction policy other than noeviction the broker will
# silently drop jobs when memory fills, and a queue that loses jobs breaks the
# credits contract (CONTRACTS section 4: every reserve must reach a settle or a
# release). maxmemory-policy noeviction is a correctness requirement.
# ---------------------------------------------------------------------------

locals {
  tags = merge(var.tags, { "montaj:module" = "elasticache-redis7" })

  default_parameters = {
    # See the note above: never evict a BullMQ key.
    "maxmemory-policy" = "noeviction"
    # Keyspace notifications for expired and evicted keys drive BullMQ's stalled
    # job detection ("Ex" is the minimum BullMQ documents).
    "notify-keyspace-events" = "Ex"
    # A command slower than 10 ms on a queue broker is worth investigating.
    "slowlog-log-slower-than" = "10000"
    "slowlog-max-len"         = "256"
  }

  parameters = merge(local.default_parameters, var.parameters)
}

resource "aws_elasticache_subnet_group" "this" {
  name        = var.name
  description = "${var.name} Redis subnet group"
  subnet_ids  = var.database_subnet_ids

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_security_group" "this" {
  name        = "${var.name}-redis"
  description = "Redis 7 for ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(local.tags, { Name = "${var.name}-redis" })
}

resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each = toset(var.allowed_security_group_ids)

  security_group_id            = aws_security_group.this.id
  description                  = "Redis from ${each.value}"
  referenced_security_group_id = each.value
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_kms_key" "this" {
  description             = "${var.name} Redis at-rest encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = local.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}-redis"
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_elasticache_parameter_group" "this" {
  name        = "${var.name}-redis7"
  family      = "redis7"
  description = "${var.name} Redis 7 tuned for BullMQ"

  dynamic "parameter" {
    for_each = local.parameters

    content {
      name  = parameter.key
      value = parameter.value
    }
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "slow" {
  name              = "/aws/elasticache/${var.name}/slow-log"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "engine" {
  name              = "/aws/elasticache/${var.name}/engine-log"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.name
  description          = "${var.name} BullMQ broker, pub/sub and cache"

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  num_cache_clusters         = var.num_cache_clusters
  automatic_failover_enabled = var.num_cache_clusters > 1
  multi_az_enabled           = var.num_cache_clusters > 1 && var.multi_az_enabled

  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.this.id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.this.arn
  transit_encryption_enabled = var.transit_encryption_enabled
  # IAM-authenticated users would be better, but the BullMQ Python worker
  # (CONTRACTS section 3) speaks plain redis-py: TLS without an AUTH token, on a
  # security group that only the node group can reach.
  transit_encryption_mode = var.transit_encryption_enabled ? "required" : null

  snapshot_retention_limit = var.snapshot_retention_days
  snapshot_window          = var.snapshot_window
  maintenance_window       = var.maintenance_window

  auto_minor_version_upgrade = true
  apply_immediately          = false

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.engine.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
  }

  tags = merge(local.tags, { Name = var.name })
}
