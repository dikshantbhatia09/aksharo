variable "name" {
  description = "Cluster name (for example \"montaj-staging\")."
  type        = string
}

variable "kubernetes_version" {
  description = "EKS control-plane minor version, for example \"1.33\". Pinned per environment so an upgrade is an explicit commit, never a drift."
  type        = string
}

variable "vpc_id" {
  description = "VPC the cluster lives in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the control-plane ENIs and the node groups."
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnets, tagged for internet-facing load balancers. Not used for nodes."
  type        = list(string)
  default     = []
}

variable "endpoint_public_access" {
  description = "Expose the Kubernetes API endpoint to the internet. Keep true only while public_access_cidrs is a real allow-list; prod should move to false plus a bastion or VPN."
  type        = bool
  default     = true
}

variable "public_access_cidrs" {
  description = "CIDRs allowed to reach the public Kubernetes API endpoint. Defaults to nothing usable on purpose: set the office/VPN ranges and the CI egress range in the environment's tfvars. [H]"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "enabled_cluster_log_types" {
  description = "Control-plane log types shipped to CloudWatch Logs. \"audit\" and \"authenticator\" are what the breach runbook reads."
  type        = list(string)
  default     = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
}

variable "control_plane_log_retention_days" {
  description = "CloudWatch Logs retention for the control-plane log group."
  type        = number
  default     = 90
}

# --- general node group ----------------------------------------------------

variable "general_instance_types" {
  description = "Instance types for the general node group. Graviton (m7g/c7g) is the default: roughly 20 percent cheaper per vCPU than the x86 equivalent, and every montaj image is built multi-arch."
  type        = list(string)
  default     = ["m7g.large"]
}

variable "general_ami_type" {
  description = "EKS AMI type for the general node group. AL2023_ARM_64_STANDARD matches the Graviton default above; use AL2023_x86_64_STANDARD with x86 instance types."
  type        = string
  default     = "AL2023_ARM_64_STANDARD"
}

variable "general_capacity_type" {
  description = "ON_DEMAND or SPOT for the general node group."
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["ON_DEMAND", "SPOT"], var.general_capacity_type)
    error_message = "general_capacity_type must be ON_DEMAND or SPOT."
  }
}

variable "general_scaling" {
  description = "Autoscaling bounds for the general node group."
  type = object({
    min_size     = number
    max_size     = number
    desired_size = number
  })
}

variable "general_disk_size_gb" {
  description = "Root EBS volume per general node, in GiB. ffmpeg scratch space lives on emptyDir, so this only holds the image cache and logs."
  type        = number
  default     = 80
}

# --- optional GPU node group ----------------------------------------------

variable "enable_gpu_node_group" {
  description = "Create an in-cluster GPU node group. Default false: decision D15 puts launch traffic on per-second serverless GPU (infra/gpu) and only moves to reserved GPU above roughly 150,000 media-minutes a month."
  type        = bool
  default     = false
}

variable "gpu_instance_types" {
  description = "Instance types for the GPU node group. g6.xlarge (L4) is the reserved-capacity target named in decision D15."
  type        = list(string)
  default     = ["g6.xlarge"]
}

variable "gpu_ami_type" {
  description = "EKS AMI type for the GPU node group."
  type        = string
  default     = "AL2023_x86_64_NVIDIA"
}

variable "gpu_capacity_type" {
  description = "ON_DEMAND or SPOT for the GPU node group."
  type        = string
  default     = "ON_DEMAND"
}

variable "gpu_scaling" {
  description = "Autoscaling bounds for the GPU node group. min_size 0 lets it scale to nothing when idle."
  type = object({
    min_size     = number
    max_size     = number
    desired_size = number
  })
  default = {
    min_size     = 0
    max_size     = 4
    desired_size = 0
  }
}

variable "gpu_disk_size_gb" {
  description = "Root EBS volume per GPU node, in GiB. Large enough for the pre-baked model image (see infra/gpu/README.md)."
  type        = number
  default     = 200
}

# --- addons and access -----------------------------------------------------

variable "addon_versions" {
  description = "Pinned EKS addon versions, keyed by addon name. An empty string means \"let EKS pick the default for this cluster version\"."
  type        = map(string)
  default = {
    "vpc-cni"                = ""
    "coredns"                = ""
    "kube-proxy"             = ""
    "aws-ebs-csi-driver"     = ""
    "eks-pod-identity-agent" = ""
  }
}

variable "access_entries" {
  description = "Extra IAM principals granted cluster access through EKS access entries (no aws-auth ConfigMap editing). Key is a stable label; policy_arn is an AmazonEKS*Policy ARN; access_scope_type is \"cluster\" or \"namespace\"."
  type = map(object({
    principal_arn     = string
    policy_arn        = string
    access_scope_type = optional(string, "cluster")
    namespaces        = optional(list(string), [])
    kubernetes_groups = optional(list(string), [])
  }))
  default = {}
}

variable "tags" {
  description = "Tags merged into every resource."
  type        = map(string)
  default     = {}
}
