# ---------------------------------------------------------------------------
# github-oidc — a deploy role GitHub Actions assumes through OIDC.
#
# No long-lived AWS access key exists for CI. The workflow exchanges its
# short-lived GitHub OIDC token for a session on this role, scoped by the `sub`
# claim to named repository environments (THREAT-MODEL T21).
# ---------------------------------------------------------------------------

locals {
  tags = merge(var.tags, { "montaj:module" = "github-oidc" })

  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_oidc_provider_arn

  repo = "${var.github_owner}/${var.github_repository}"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS validates the GitHub OIDC endpoint against its own trust store; the
  # thumbprint is retained only because the API still accepts the field.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = local.tags
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The list is exact, not a prefix match: only the named environments deploy.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = var.allowed_subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-github-deploy"
  description          = "Assumed by GitHub Actions in ${local.repo} to deploy ${var.name}."
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = var.max_session_duration_seconds

  tags = local.tags

  lifecycle {
    precondition {
      condition     = var.create_oidc_provider || var.existing_oidc_provider_arn != ""
      error_message = "Set create_oidc_provider = true, or pass existing_oidc_provider_arn."
    }
  }
}

data "aws_iam_policy_document" "deploy" {
  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [1] : []

    content {
      sid       = "EcrAuth"
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [1] : []

    content {
      sid = "EcrPush"

      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeImages",
        "ecr:DescribeRepositories",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
      ]

      resources = var.ecr_repository_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.eks_cluster_arns) > 0 ? [1] : []

    content {
      sid       = "EksDescribeForKubeconfig"
      actions   = ["eks:DescribeCluster", "eks:ListClusters"]
      resources = var.eks_cluster_arns
    }
  }

  dynamic "statement" {
    for_each = var.terraform_state_bucket_arn != "" ? [1] : []

    content {
      sid       = "TerraformStateList"
      actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
      resources = [var.terraform_state_bucket_arn]
    }
  }

  dynamic "statement" {
    for_each = var.terraform_state_bucket_arn != "" ? [1] : []

    content {
      sid = "TerraformStateObjects"

      actions = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
      ]

      resources = ["${var.terraform_state_bucket_arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.ssm_parameter_path_arn != "" ? [1] : []

    content {
      sid       = "ReadReleaseParameters"
      actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
      resources = [var.ssm_parameter_path_arn]
    }
  }

  statement {
    sid       = "WhoAmI"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "deploy" {
  name        = "${var.name}-github-deploy"
  description = "Least-privilege deploy permissions for ${local.repo}."
  policy      = data.aws_iam_policy_document.deploy.json

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}
