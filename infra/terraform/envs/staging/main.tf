# ---------------------------------------------------------------------------
# Staging root module.
#
# Staging is deliberately the cheapest configuration that still exercises every
# code path prod uses: same modules, same encryption, same lifecycle rules,
# smaller instances, one NAT gateway, no read replica, no Multi-AZ.
#
# Nothing here has ever been applied. See infra/README.md for bootstrap order
# and the [H] items that need a human with real credentials.
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

  # Built from the account and region rather than from module.eks, so the
  # github-oidc module can grant access to the cluster while the eks module
  # grants the deploy role access INTO the cluster, without a dependency cycle.
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

  # One NAT gateway: staging can tolerate losing an availability zone, and a
  # second gateway is a flat monthly charge for no test coverage.
  single_nat_gateway = true

  enable_flow_logs        = true
  flow_log_retention_days = 14

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

  general_scaling = {
    min_size     = 2
    max_size     = 6
    desired_size = 2
  }

  # Decision D15: no reserved GPU until roughly 150,000 media-minutes a month.
  # Staging AI work goes to the serverless provider in infra/gpu.
  enable_gpu_node_group = false

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
  allocated_storage_gb     = 50
  max_allocated_storage_gb = 200

  multi_az              = false
  backup_retention_days = var.postgres_backup_retention_days
  create_read_replica   = false

  # A staging database is disposable; prod is not.
  deletion_protection = false
  skip_final_snapshot = true

  tags = local.common_tags
}

module "redis" {
  source = "../../modules/elasticache-redis7"

  name                = local.name
  vpc_id              = module.network.vpc_id
  database_subnet_ids = module.network.database_subnet_ids

  allowed_security_group_ids = [module.eks.cluster_security_group_id]

  node_type               = var.redis_node_type
  num_cache_clusters      = 1
  multi_az_enabled        = false
  snapshot_retention_days = 1

  tags = local.common_tags
}

# --- object storage --------------------------------------------------------

module "s3_raw" {
  source = "../../modules/s3-raw"

  bucket_name      = "montaj-raw-${var.environment}"
  residency_region = var.aws_region
  web_origins      = [module.dns.web_origin]

  # Acceptance criterion 3 of the X05 brief: these three numbers.
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
}

# --- dns -------------------------------------------------------------------

module "dns" {
  source = "../../modules/dns-cdn"

  zone_id          = var.cloudflare_zone_id
  zone_name        = "aksharo.ai"
  subdomain_prefix = var.environment

  # Points at TEST-NET-1 until the ingress load balancer exists; the deploy
  # runbook replaces it as its last step.
  ingress_target = "192.0.2.1"

  manage_apex = false
  proxied     = true

  # The apex records belong to prod; staging must not touch them.
  manage_zone_settings          = false
  manage_email_security_records = false
}

# --- ci deploy identity ----------------------------------------------------

module "github_oidc" {
  source = "../../modules/github-oidc"

  name              = local.name
  github_owner      = var.github_owner
  github_repository = var.github_repository

  create_oidc_provider       = var.create_github_oidc_provider
  existing_oidc_provider_arn = var.existing_github_oidc_provider_arn

  allowed_subjects = [
    "repo:${var.github_owner}/${var.github_repository}:environment:staging",
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

  # The eleven CONTRACTS section 1 variables Terraform can compute. Every other
  # variable becomes a placeholder parameter for a human to fill in once; see
  # `terraform output human_supplied_parameters`.
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
# Same per-workload IAM roles as production (P0-09). Staging is where the
# closure evidence for least privilege is produced: `aws iam
# simulate-principal-policy` against each role, plus a live canary showing the
# web role cannot read a payment or provider secret and the api role can send
# SES and reach only the allowed prefixes.

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

  ses_identity_arn          = var.ses_identity_arn
  ses_configuration_set_arn = var.ses_configuration_set_arn
  mail_from_address         = var.mail_from_address

  canary_bucket_arns = [module.s3_raw.bucket_arn]

  tags = local.common_tags
}
