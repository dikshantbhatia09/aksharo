# ---------------------------------------------------------------------------
# secrets — one KMS key and one SSM parameter per CONTRACTS section 1 variable,
# plus the IRSA role external-secrets uses to project them into the cluster.
#
# THREAT-MODEL T21 (secrets in code and logs): no real secret value is ever
# passed to Terraform. Human-supplied parameters are created with a placeholder
# and then ignored, so `terraform plan` output and the state file contain the
# parameter names and nothing else.
# ---------------------------------------------------------------------------

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

locals {
  tags = merge(var.tags, { "montaj:module" = "secrets" })

  path_prefix = "${var.parameter_prefix}/${var.environment}"

  # Values Terraform owns must actually be supplied; a silent placeholder in a
  # managed parameter would boot the application against a broken endpoint.
  missing_managed_values = [
    for name, _ in local.managed_parameters : name
    if !contains(keys(var.values), name)
  ]
}

resource "terraform_data" "managed_values_present" {
  lifecycle {
    precondition {
      condition     = length(local.missing_managed_values) == 0
      error_message = "The secrets module computes these CONTRACTS section 1 parameters but the caller supplied no value: ${join(", ", local.missing_managed_values)}. Either pass them in `values` or mark them human = true in contract.tf."
    }
  }
}

# --- KMS -------------------------------------------------------------------

resource "aws_kms_key" "this" {
  description             = "${var.name} application secrets (SSM SecureString)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json

  tags = local.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.this.key_id
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "SsmService"

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]

    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${data.aws_region.current.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# --- parameters Terraform owns ---------------------------------------------

resource "aws_ssm_parameter" "managed" {
  for_each = local.managed_parameters

  name        = "${local.path_prefix}/${each.key}"
  description = each.value.description
  type        = each.value.secret ? "SecureString" : "String"
  key_id      = each.value.secret ? aws_kms_key.this.id : null
  value       = var.values[each.key]
  tier        = "Standard"

  tags = merge(local.tags, {
    "montaj:contract-var"   = each.key
    "montaj:human-required" = "false"
  })

  depends_on = [terraform_data.managed_values_present]
}

# --- parameters a human owns -----------------------------------------------

resource "aws_ssm_parameter" "human" {
  for_each = local.human_parameters

  name        = "${local.path_prefix}/${each.key}"
  description = "[H] ${each.value.description}"
  type        = each.value.secret ? "SecureString" : "String"
  key_id      = each.value.secret ? aws_kms_key.this.id : null
  value       = var.placeholder
  tier        = "Standard"

  tags = merge(local.tags, {
    "montaj:contract-var"   = each.key
    "montaj:human-required" = "true"
  })

  lifecycle {
    # The whole point: after creation the value belongs to whoever filled it in.
    # Terraform must never read it back, diff it, or overwrite it.
    ignore_changes = [value, insecure_value]
  }
}

# --- read access -----------------------------------------------------------

data "aws_iam_policy_document" "read" {
  statement {
    sid = "ReadEnvironmentParameters"

    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:DescribeParameters",
    ]

    resources = [
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.path_prefix}/*",
    ]
  }

  statement {
    sid       = "DecryptSecureStrings"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "read" {
  name        = "${var.name}-secrets-read"
  description = "Read ${local.path_prefix}/* and decrypt its SecureStrings."
  policy      = data.aws_iam_policy_document.read.json

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "extra_readers" {
  for_each = toset(var.reader_role_arns)

  role       = element(split("/", each.value), length(split("/", each.value)) - 1)
  policy_arn = aws_iam_policy.read.arn
}

# --- external-secrets IRSA role --------------------------------------------

data "aws_iam_policy_document" "external_secrets_assume" {
  count = var.oidc_provider_arn != "" ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:sub"
      values   = ["system:serviceaccount:${var.external_secrets_namespace}:${var.external_secrets_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "external_secrets" {
  count = var.oidc_provider_arn != "" ? 1 : 0

  name               = "${var.name}-external-secrets"
  description        = "Assumed by the external-secrets controller to project ${local.path_prefix}/* into Kubernetes Secrets."
  assume_role_policy = data.aws_iam_policy_document.external_secrets_assume[0].json

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "external_secrets" {
  count = var.oidc_provider_arn != "" ? 1 : 0

  role       = aws_iam_role.external_secrets[0].name
  policy_arn = aws_iam_policy.read.arn
}
