# ---------------------------------------------------------------------------
# workload-irsa — one IAM role per Kubernetes workload, trusted only by that
# workload's service account.
#
# This module exists because the ones around it stopped one step short. The
# s3-raw module outputs `access_policy_arn` with the description "Attach to the
# api, worker-media and worker-ai IRSA roles"; the Helm chart's
# `serviceaccount.yaml` supports a `serviceAccountAnnotations` hook. Neither
# side ever created a role, so nothing was attached to anything: the pods ran
# with no AWS identity at all, S3 worked only because static access keys were
# injected into every process, and the SES mailer — which deliberately uses the
# pod credential chain (`apps/api/src/notify/ses.provider.ts`) — could not have
# sent a message (launch-readiness P0-09).
#
# The trust policy is scoped by the OIDC `sub` claim to the exact
# namespace/serviceaccount pair, so the role is assumable by that one workload
# and not by any other pod in the cluster.
# ---------------------------------------------------------------------------

locals {
  tags = merge(var.tags, { "montaj:module" = "workload-irsa" })

  # `oidc.eks.<region>.amazonaws.com/id/XXXX` — the provider URL without its
  # scheme, which is how the condition keys are named.
  oidc_host = replace(var.oidc_provider_url, "https://", "")
}

data "aws_iam_policy_document" "assume" {
  for_each = var.workloads

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Exact, not a prefix: `system:serviceaccount:<ns>:<name>` and nothing else.
    # A `StringLike` with a wildcard here would let every service account in the
    # namespace assume every workload role, which is the same as having one role.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${each.value.service_account}"]
    }
  }
}

resource "aws_iam_role" "workload" {
  for_each = var.workloads

  name               = "${var.name}-${each.key}"
  description        = "IRSA role for the ${each.key} workload in ${var.namespace}. ${each.value.description}"
  assume_role_policy = data.aws_iam_policy_document.assume[each.key].json

  # An hour: long enough that a render job does not lose its credentials
  # mid-upload, short enough that a leaked session is not a lasting one.
  max_session_duration = 3600

  tags = merge(local.tags, { "montaj:workload" = each.key })
}

# --- Managed policies the caller chose to attach --------------------------

locals {
  # Flatten {workload => [policy_arn]} into a set of "workload|arn" keys, because
  # `aws_iam_role_policy_attachment` is one resource per pair.
  attachments = merge([
    for workload, spec in var.workloads : {
      for arn in spec.policy_arns : "${workload}|${arn}" => {
        workload   = workload
        policy_arn = arn
      }
    }
  ]...)
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each = local.attachments

  role       = aws_iam_role.workload[each.value.workload].name
  policy_arn = each.value.policy_arn
}

# --- SES: the API's send permission ----------------------------------------
#
# Scoped to one verified identity and one configuration set. `ses:FromAddress`
# means a compromised API can send *as the product* but cannot send as anything
# else, which is what protects the sending domain's reputation.

data "aws_iam_policy_document" "ses_send" {
  count = var.ses_identity_arn == null ? 0 : 1

  statement {
    sid     = "SendAsVerifiedIdentity"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = compact([
      var.ses_identity_arn,
      var.ses_configuration_set_arn,
    ])

    dynamic "condition" {
      for_each = var.mail_from_address == null ? [] : [var.mail_from_address]
      content {
        test     = "StringEquals"
        variable = "ses:FromAddress"
        values   = [condition.value]
      }
    }
  }
}

resource "aws_iam_policy" "ses_send" {
  count = var.ses_identity_arn == null ? 0 : 1

  name        = "${var.name}-ses-send"
  description = "Send transactional mail as the verified identity. Attach to the api workload only."
  policy      = data.aws_iam_policy_document.ses_send[0].json
  tags        = local.tags
}

resource "aws_iam_role_policy_attachment" "ses_send" {
  for_each = var.ses_identity_arn == null ? toset([]) : toset(var.ses_sender_workloads)

  role       = aws_iam_role.workload[each.value].name
  policy_arn = aws_iam_policy.ses_send[0].arn
}

# --- The object-store health canary ----------------------------------------
#
# `apps/api/src/health/health.service.ts` writes, reads back and deletes one
# small object at boot to prove its credentials actually work. It needs its own
# grant because the canary prefix is deliberately outside the `ws/` paths the
# bucket policy scopes customer media to.

data "aws_iam_policy_document" "health_canary" {
  count = length(var.canary_bucket_arns) == 0 ? 0 : 1

  statement {
    sid     = "HealthCanaryObjects"
    actions = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = [
      for arn in var.canary_bucket_arns : "${arn}/${var.canary_prefix}*"
    ]
  }
}

resource "aws_iam_policy" "health_canary" {
  count = length(var.canary_bucket_arns) == 0 ? 0 : 1

  name        = "${var.name}-health-canary"
  description = "Write/read/delete the boot-time object-store canary under ${var.canary_prefix}."
  policy      = data.aws_iam_policy_document.health_canary[0].json
  tags        = local.tags
}

resource "aws_iam_role_policy_attachment" "health_canary" {
  for_each = length(var.canary_bucket_arns) == 0 ? toset([]) : toset(var.canary_workloads)

  role       = aws_iam_role.workload[each.value].name
  policy_arn = aws_iam_policy.health_canary[0].arn
}
