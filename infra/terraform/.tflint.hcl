# tflint configuration for infra/terraform.
#
#   tflint --init          # downloads the AWS ruleset plugin (needs network)
#   tflint --recursive     # lints every module and both environments
#
# The bundled `terraform` ruleset needs no download; the AWS ruleset does. CI
# runs `tflint --init` first, so a missing plugin is a build failure rather than
# a silently reduced lint.

config {
  call_module_type = "local"
  force            = false
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.44.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# Naming and documentation conventions we actually hold ourselves to.
rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}

rule "terraform_typed_variables" {
  enabled = true
}

rule "terraform_naming_convention" {
  enabled = true
  format  = "snake_case"
}

rule "terraform_required_version" {
  enabled = true
}

rule "terraform_required_providers" {
  enabled = true
}

rule "terraform_unused_declarations" {
  enabled = true
}

rule "terraform_deprecated_interpolation" {
  enabled = true
}

# Off on purpose: the environment roots pin provider versions in versions.tf and
# the modules declare compatible ranges, which is the layout this rule wants to
# forbid in favour of a lockfile per module. A module has no lockfile.
rule "terraform_module_pinned_source" {
  enabled = false
}
