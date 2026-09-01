# ---------------------------------------------------------------------------
# s3-raw — the raw-upload bucket. ap-south-1 only (THREAT-MODEL T24), encrypted,
# versioned, private, and with lifecycle rules that make deletion real.
#
# Key layout (CONTRACTS section 6):
#   ws/{workspaceId}/p/{projectId}/media/{mediaId}/raw.{ext}
#
# Derived objects do NOT live here: proxies, waveforms, thumbnails, exports and
# fonts go to Cloudflare R2 (decision D35, module r2-derived) so client-facing
# egress is free.
# ---------------------------------------------------------------------------

data "aws_region" "current" {}

locals {
  tags = merge(var.tags, { "montaj:module" = "s3-raw" })

  use_kms = var.kms_key_arn != ""
}

# A wrong provider region here is a residency breach, not a typo, so fail the
# plan rather than create the bucket in the wrong place.
resource "terraform_data" "residency_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_region.current.region == var.residency_region
      error_message = "s3-raw must be created in ${var.residency_region} (THREAT-MODEL T24, data residency), but the provider is configured for ${data.aws_region.current.region}."
    }
  }
}

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name

  tags = merge(local.tags, {
    Name                  = var.bucket_name
    "montaj:residency"    = var.residency_region
    "montaj:data-class"   = "user-media-raw"
    "montaj:contains-pii" = "true"
  })

  depends_on = [terraform_data.residency_guard]
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    # ACLs off entirely: access is decided by the bucket policy and IAM alone.
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.use_kms ? "aws:kms" : "AES256"
      kms_master_key_id = local.use_kms ? var.kms_key_arn : null
    }

    # One data key per bucket-and-prefix instead of one per object: the same
    # protection at a fraction of the KMS request bill.
    bucket_key_enabled = local.use_kms
  }
}

# ---------------------------------------------------------------------------
# Lifecycle. Acceptance criterion 3 of the X05 brief lives here.
#
#   1 abort-incomplete-multipart   1 day   every prefix
#   2 noncurrent version expiry    7 days  every prefix
#   3 tagged purge                 7 days  objects the API tagged as finished
#   4 backstop expiry            400 days  anything the tagging path missed
# ---------------------------------------------------------------------------
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # Rule 1: abandoned multipart uploads. Raw media is uploaded in parts; a
  # browser tab closed mid-upload leaves parts that are billed but invisible.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_multipart_days
    }
  }

  # Rule 2: non-current versions. Versioning protects against an accidental
  # overwrite; without this rule it also quietly resurrects deleted user media,
  # which would make the erasure promise in 05 section 9 false (decision D47).
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    # A delete marker with no versions behind it is dead weight.
    expiration {
      expired_object_delete_marker = true
    }
  }

  # Rule 3: the real purge. The API tags a raw object once the last job that
  # needs it has settled; seven days later S3 deletes it.
  rule {
    id     = "purge-tagged-raw-media"
    status = "Enabled"

    filter {
      tag {
        key   = var.purge_tag_key
        value = var.purge_tag_value
      }
    }

    expiration {
      days = var.purge_after_days
    }
  }

  # Rule 4: backstop. If the tagging path ever breaks, raw media still leaves
  # the bucket rather than accumulating for the life of the company.
  dynamic "rule" {
    for_each = var.backstop_expiration_days > 0 ? [1] : []

    content {
      id     = "backstop-expire-raw-media"
      status = "Enabled"

      filter {
        prefix = "ws/"
      }

      expiration {
        days = var.backstop_expiration_days
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# CORS for the presigned multipart PUT the browser performs during upload
# (05 section 5.1). ETag must be exposed or the browser cannot complete a
# multipart upload; the x-amz-* headers carry the part numbers.
resource "aws_s3_bucket_cors_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  cors_rule {
    id              = "presigned-browser-upload"
    allowed_origins = var.web_origins
    allowed_methods = ["PUT", "POST", "GET", "HEAD", "DELETE"]
    allowed_headers = ["*"]
    expose_headers = [
      "ETag",
      "x-amz-request-id",
      "x-amz-version-id",
      "x-amz-server-side-encryption",
      "x-amz-checksum-crc32",
    ]
    max_age_seconds = var.cors_max_age_seconds
  }
}

resource "aws_s3_bucket_logging" "this" {
  count = var.log_bucket_name != "" ? 1 : 0

  bucket        = aws_s3_bucket.this.id
  target_bucket = var.log_bucket_name
  target_prefix = "s3-access/${var.bucket_name}/"
}

# --- bucket policy ---------------------------------------------------------

data "aws_iam_policy_document" "bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyUnencryptedObjectUploads"
    effect = "Deny"

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = [local.use_kms ? "aws:kms" : "AES256"]
    }

    # A PUT that says nothing about encryption gets the bucket default, which is
    # already encrypted; only an explicit wrong value is refused.
    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

# --- least-privilege access policy -----------------------------------------

# Attached to the api and worker IRSA roles. Object actions are scoped to the
# ws/ prefix so a compromised worker cannot touch bucket configuration.
data "aws_iam_policy_document" "access" {
  statement {
    sid = "ListOwnPrefixes"

    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.this.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["ws/*"]
    }
  }

  statement {
    sid = "ReadWriteMedia"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectTagging",
      "s3:PutObject",
      "s3:PutObjectTagging",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]

    resources = ["${aws_s3_bucket.this.arn}/ws/*"]
  }

  dynamic "statement" {
    for_each = local.use_kms ? [1] : []

    content {
      sid       = "UseBucketKey"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [var.kms_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${data.aws_region.current.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_policy" "access" {
  name        = "${var.bucket_name}-access"
  description = "Read/write objects under ws/ in ${var.bucket_name}. Attach to the api and worker IRSA roles."
  policy      = data.aws_iam_policy_document.access.json

  tags = local.tags
}
