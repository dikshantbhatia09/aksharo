variable "name" {
  description = "Name prefix for every resource in this VPC (for example \"montaj-staging\")."
  type        = string
}

variable "cidr_block" {
  description = "IPv4 CIDR for the VPC. Must be large enough for one /20 public, one /19 private and one /24 database subnet per availability zone."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.cidr_block))
    error_message = "cidr_block must be a valid IPv4 CIDR, for example \"10.20.0.0/16\"."
  }
}

variable "azs" {
  description = "Availability zones to spread subnets across. Listed explicitly (not discovered) so a plan is reproducible from the repository alone. THREAT-MODEL T24: every zone must be inside the residency region."
  type        = list(string)

  validation {
    condition     = length(var.azs) >= 2
    error_message = "At least two availability zones are required for RDS Multi-AZ and ElastiCache automatic failover."
  }
}

variable "public_subnet_cidrs" {
  description = "One CIDR per availability zone for the public (ingress + NAT) tier."
  type        = list(string)
}

variable "private_subnet_cidrs" {
  description = "One CIDR per availability zone for the private (EKS node) tier."
  type        = list(string)
}

variable "database_subnet_cidrs" {
  description = "One CIDR per availability zone for the database (RDS + ElastiCache) tier. No route to the internet."
  type        = list(string)
}

variable "single_nat_gateway" {
  description = "true places one NAT gateway in the first public subnet and routes every private subnet through it (staging: cheaper, one AZ of blast radius). false creates one NAT gateway per AZ (prod: no cross-AZ single point of failure). See infra/terraform/README.md for the cost difference."
  type        = bool
  default     = false
}

variable "enable_flow_logs" {
  description = "Send VPC flow logs to CloudWatch Logs. Required in prod for the breach runbook (docs/runbooks/breach-first-hour.md)."
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "CloudWatch Logs retention for VPC flow logs, in days."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags merged into every resource."
  type        = map(string)
  default     = {}
}
