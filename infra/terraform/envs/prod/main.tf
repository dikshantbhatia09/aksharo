# ---------------------------------------------------------------------------
# Production root module.
#
# Same modules as staging, same encryption, same lifecycle rules. The
# differences are deliberate and few: three availability zones, a NAT gateway
# per zone, Multi-AZ Postgres with a read replica and a 35-day PITR window, a
# replicated Redis group, deletion protection on, and the apex DNS records plus
# zone-level TLS settings.
#
# Nothing here has ever been applied. See infra/README.md for bootstrap order.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

locals {
  name = "montaj-${var.environment}"

  common_tags = merge(var.extra_tags, {
    "montaj:environment"  = var.environment
    "montaj:managed-by"   = "terraform"
    "montaj:repo"         = "${var.github_owner}/${var.github_repository}"
    "montaj:work-package" = "X05"
  })

  eks_cluster_arn = "arn:aws:eks:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cluster/${local.name}"
}

# --- network ---------------------------------------------------------------

module "network" {
  source = "../../modules/network"

  name                  = local.name
  cidr_block            = var.vpc_cidr
  azs                   = var.availability_zones
  public_subnet_cidrs   = var.public_subnet_cidrs
  private_subnet_cidrs  = var.private_subnet_cidrs
  database_subnet_cidrs = var.database_subnet_cidrs

  # One NAT gateway per zone: losing a zone must not take egress with it.
  single_nat_gateway = false

  enable_flow_logs        = true
  flow_log_retention_days = 90

  tags = local.common_tags
}

# --- cluster ---------------------------------------------------------------

module "eks" {
  source = "../../modules/eks"

  name               = local.name
  kubernetes_version = var.kubernetes_version

  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  public_subnet_ids  = module.network.public_subnet_ids

  endpoint_public_access = true
  public_access_cidrs    = var.kubernetes_api_allowed_cidrs

  general_instance_types = ["m7g.xlarge"]

  general_scaling = {
    min_size     = 3
    max_size     = 24
    desired_size = 3
  }

  general_disk_size_gb = 120

  # Decision D15: serverless GPU until roughly 150,000 media-minutes a month.
  # Flip to true and set gpu_scaling once the benchmark says reserved L4 wins.
  enable_gpu_node_group = false

  control_plane_log_retention_days = 365

  access_entries = {
    github_deploy = {
      principal_arn     = module.github_oidc.role_arn
      policy_arn        = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"
      access_scope_type = "namespace"
      namespaces        = ["montaj"]
    }
  }

  tags = local.common_tags
}

# --- data stores -----------------------------------------------------------

module "postgres" {
  source = "../../modules/rds-postgres16"

  name                = local.name
  vpc_id              = module.network.vpc_id
  database_subnet_ids = module.network.database_subnet_ids

  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  engine_version           = var.postgres_engine_version
  instance_class           = var.postgres_instance_class
  allocated_storage_gb     = 200
  max_allocated_storage_gb = 2000

  multi_az              = true
  backup_retention_days = var.postgres_backup_retention_days

  # 05 section 10: read traffic (admin views, the daily COGS rollup) goes to a
  # replica behind PgBouncer, not to the writer.
  create_read_replica = true

  deletion_protection = true
  skip_final_snapshot = false

  performance_insights_retention_days = 7

  tags = local.common_tags
}

module "redis" {
  source = "../../modules/elasticache-redis7"

  name                = local.name
  vpc_id              = module.network.vpc_id
  database_subnet_ids = module.network.database_subnet_ids

  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  node_type               = var.redis_node_type
  num_cache_clusters      = 2
  multi_az_enabled        = true
  snapshot_retention_days = 7

  tags = local.common_tags
}

# --- object storage --------------------------------------------------------

module "s3_raw" {
  source = "../../modules/s3-raw"

  bucket_name      = "montaj-raw-${var.environment}"
  residency_region = var.aws_region
  web_origins      = [module.dns.web_origin]

  noncurrent_version_expiration_days = 7
  abort_incomplete_multipart_days    = 1
  purge_after_days                   = 7

  tags = local.common_tags
}

module "r2_derived" {
  source = "../../modules/r2-derived"

  account_id    = var.cloudflare_account_id
  bucket_name   = "montaj-derived-${var.environment}"
  location_hint = "APAC"
  web_origins   = [module.dns.web_origin]

  # Empty by ruling (Fable, 2026-09-02): CONTRACTS section 6 keys are frozen, so
  # the plan cannot appear in a key prefix and R2 lifecycle can only match a
  # literal prefix. Plan retention (Free 7 d, Starter 30 d, Creator 90 d,
  # Studio/Agency 365 d) is enforced by the scheduler in B16.
  retention_prefixes = {}

  # The one lifecycle rule that is both expressible under section 6 and worth
  # having: abandoned multipart parts are billed and invisible in a listing.
  multipart_abort_prefixes        = ["ws/"]
  abort_incomplete_multipart_days = 1

  custom_domain         = "cdn.aksharo.ai"
  custom_domain_zone_id = var.cloudflare_zone_id
}

# --- dns -------------------------------------------------------------------

module "dns" {
  source = "../../modules/dns-cdn"

  zone_id   = var.cloudflare_zone_id
  zone_name = "aksharo.ai"

  # No prefix in production: app.aksharo.ai, api.aksharo.ai.
  subdomain_prefix = ""

  ingress_target = "192.0.2.1"
  apex_target    = "192.0.2.1"

  manage_apex = true
  proxied     = true

  manage_zone_settings          = true
  manage_email_security_records = true
}

# --- ci deploy identity ----------------------------------------------------

module "github_oidc" {
  source = "../../modules/github-oidc"

  name              = local.name
  github_owner      = var.github_owner
  github_repository = var.github_repository

  create_oidc_provider       = var.create_github_oidc_provider
  existing_oidc_provider_arn = var.existing_github_oidc_provider_arn

  # Environment subject, not a branch subject: a GitHub environment can require
  # a human reviewer before the job runs, and a production deploy should.
  allowed_subjects = [
    "repo:${var.github_owner}/${var.github_repository}:environment:production",
  ]

  eks_cluster_arns       = [local.eks_cluster_arn]
  ssm_parameter_path_arn = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/montaj/${var.environment}/*"

  tags = local.common_tags
}

# --- secrets ---------------------------------------------------------------

module "secrets" {
  source = "../../modules/secrets"

  name        = local.name
  environment = var.environment

  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url

  values = {
    REDIS_URL          = module.redis.redis_url
    S3_ENDPOINT        = module.s3_raw.s3_endpoint
    S3_REGION          = module.s3_raw.region
    S3_BUCKET_RAW      = module.s3_raw.bucket_name
    R2_ENDPOINT        = module.r2_derived.s3_api_endpoint
    R2_BUCKET_DERIVED  = module.r2_derived.bucket_name
    WEB_ORIGIN         = module.dns.web_origin
    API_ORIGIN         = module.dns.api_origin
    LLM_PROVIDER       = var.llm_provider
    GPU_PROVIDER       = var.gpu_provider
    FEATURE_FLAGS_JSON = var.feature_flags_json
  }

  tags = local.common_tags
}

# --- workload identity -----------------------------------------------------
#
# One IAM role per workload, trusted only by that workload's service account.
# Until this existed, the s3-raw module output a policy whose description said
# "attach to the api and worker IRSA roles" and no such role was ever created:
# the pods had no AWS identity, every process was handed static access keys
# through the shared secret instead, and the SES mailer — which uses the pod
# credential chain by design — could not have sent a message (P0-09).
#
# Feed `module.workload_irsa.helm_service_account_annotations` into
# values-prod.yaml rather than hand-writing ARNs.

module "workload_irsa" {
  source = "../../modules/workload-irsa"

  name              = local.name
  namespace         = var.kubernetes_namespace
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url

  workloads = {
    api = {
      service_account = "montaj-api"
      description     = "REST API: raw media, SES, the health canary."
      policy_arns     = [module.s3_raw.access_policy_arn]
    }
    web = {
      service_account = "montaj-web"
      description     = "Next server. Renders and proxies; needs no AWS resource of its own."
      policy_arns     = []
    }
    worker-media = {
      service_account = "montaj-worker-media"
      description     = "ffprobe/ffmpeg over raw media."
      policy_arns     = [module.s3_raw.access_policy_arn]
    }
    worker-ai = {
      service_account = "montaj-worker-ai"
      description     = "Reads raw audio for ASR; provider keys come from its own secret."
      policy_arns     = [module.s3_raw.access_policy_arn]
    }
    render = {
      service_account = "montaj-render"
      description     = "Reads raw media and writes exports."
      policy_arns     = [module.s3_raw.access_policy_arn]
    }
  }

  # Mail. `ses_identity_arn = null` (the default) leaves the policy uncreated,
  # which is the right state until the domain is verified and out of the SES
  # sandbox — an unattachable policy is better than one granting send on "*".
  ses_identity_arn          = var.ses_identity_arn
  ses_configuration_set_arn = var.ses_configuration_set_arn
  mail_from_address         = var.mail_from_address

  # The API's boot-time write/read/delete canary. Raw only: the derived store is
  # Cloudflare R2, which is not IAM-governed and still uses a static key pair.
  canary_bucket_arns = [module.s3_raw.bucket_arn]

  tags = local.common_tags
}
