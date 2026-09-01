# ---------------------------------------------------------------------------
# Remote state: S3 with native state locking (use_lockfile, Terraform 1.11+).
# No DynamoDB table is needed any more.
#
# The block is deliberately empty (a "partial backend"): the bucket name and the
# state key are supplied at init time so this file can be read, diffed and
# validated by anyone, and so `terraform validate` works with no credentials:
#
#   terraform init -backend-config=backend.hcl      # real use
#   terraform init -backend=false                   # validate only, no state
#
# Copy backend.hcl.example to backend.hcl and fill it in. backend.hcl is
# gitignored: it names a real bucket in a real account.
# ---------------------------------------------------------------------------

terraform {
  backend "s3" {}
}
