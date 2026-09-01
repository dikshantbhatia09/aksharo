# ---------------------------------------------------------------------------
# eks — control plane, managed node groups (general + optional GPU), addons,
# IRSA provider and access entries.
#
# Written against the AWS provider directly rather than the community EKS module
# so every permission and every log type is visible in review. Secrets are
# envelope-encrypted with a dedicated customer-managed KMS key (THREAT-MODEL T21).
# ---------------------------------------------------------------------------

data "aws_partition" "current" {}

locals {
  tags = merge(var.tags, { "montaj:module" = "eks" })

  # EKS node groups need both subnet tiers tagged, but nodes themselves are
  # private-only: a compromised worker has no direct inbound path.
  node_subnet_ids = var.private_subnet_ids
}

# --- KMS key for envelope encryption of Kubernetes secrets -----------------

resource "aws_kms_key" "cluster" {
  description             = "${var.name} EKS secret envelope encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = local.tags
}

resource "aws_kms_alias" "cluster" {
  name          = "alias/${var.name}-eks"
  target_key_id = aws_kms_key.cluster.key_id
}

# --- control plane ---------------------------------------------------------

data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-eks-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each = toset([
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSClusterPolicy",
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSVPCResourceController",
  ])

  role       = aws_iam_role.cluster.name
  policy_arn = each.value
}

resource "aws_security_group" "cluster" {
  name        = "${var.name}-eks-cluster"
  description = "EKS control-plane cross-account ENIs for ${var.name}"
  vpc_id      = var.vpc_id

  tags = merge(local.tags, { Name = "${var.name}-eks-cluster" })
}

resource "aws_vpc_security_group_egress_rule" "cluster_all" {
  security_group_id = aws_security_group.cluster.id
  description       = "Control plane to nodes and AWS APIs"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.name}/cluster"
  retention_in_days = var.control_plane_log_retention_days

  tags = local.tags
}

resource "aws_eks_cluster" "this" {
  name     = var.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  enabled_cluster_log_types = var.enabled_cluster_log_types

  access_config {
    # API mode only: cluster authorisation is IAM access entries, never a
    # hand-edited aws-auth ConfigMap (THREAT-MODEL T20).
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }

  encryption_config {
    resources = ["secrets"]

    provider {
      key_arn = aws_kms_key.cluster.arn
    }
  }

  vpc_config {
    subnet_ids              = concat(var.private_subnet_ids, var.public_subnet_ids)
    security_group_ids      = [aws_security_group.cluster.id]
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access ? var.public_access_cidrs : null
  }

  tags = local.tags

  depends_on = [
    aws_iam_role_policy_attachment.cluster,
    aws_cloudwatch_log_group.cluster,
  ]
}

# --- IRSA ------------------------------------------------------------------

data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "this" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]

  tags = local.tags
}

# --- node IAM role ---------------------------------------------------------

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-eks-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    # SSM Session Manager replaces SSH: no bastion, no key pairs, no port 22.
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ])

  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# --- launch template (IMDSv2 required, encrypted root volume) --------------

resource "aws_launch_template" "general" {
  name_prefix = "${var.name}-general-"

  metadata_options {
    # IMDSv1 lets any SSRF inside a pod read the node role's credentials.
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    http_endpoint               = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.general_disk_size_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-general" })
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-general"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = local.node_subnet_ids
  ami_type        = var.general_ami_type
  capacity_type   = var.general_capacity_type
  instance_types  = var.general_instance_types

  launch_template {
    id      = aws_launch_template.general.id
    version = aws_launch_template.general.latest_version
  }

  scaling_config {
    min_size     = var.general_scaling.min_size
    max_size     = var.general_scaling.max_size
    desired_size = var.general_scaling.desired_size
  }

  update_config {
    max_unavailable_percentage = 33
  }

  labels = {
    "montaj.ai/pool" = "general"
  }

  tags = local.tags

  lifecycle {
    # The cluster autoscaler / Karpenter owns desired_size after creation.
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}

resource "aws_launch_template" "gpu" {
  count = var.enable_gpu_node_group ? 1 : 0

  name_prefix = "${var.name}-gpu-"

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    http_endpoint               = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.gpu_disk_size_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-gpu" })
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "gpu" {
  count = var.enable_gpu_node_group ? 1 : 0

  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-gpu"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = local.node_subnet_ids
  ami_type        = var.gpu_ami_type
  capacity_type   = var.gpu_capacity_type
  instance_types  = var.gpu_instance_types

  launch_template {
    id      = aws_launch_template.gpu[0].id
    version = aws_launch_template.gpu[0].latest_version
  }

  scaling_config {
    min_size     = var.gpu_scaling.min_size
    max_size     = var.gpu_scaling.max_size
    desired_size = var.gpu_scaling.desired_size
  }

  labels = {
    "montaj.ai/pool"     = "gpu"
    "nvidia.com/gpu"     = "true"
    "montaj.ai/gpu-tier" = "reserved"
  }

  # Only pods that tolerate this taint land on GPU nodes: nothing schedules
  # a CPU worker onto an hourly accelerator by accident.
  taint {
    key    = "nvidia.com/gpu"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}

# --- addons ----------------------------------------------------------------

resource "aws_eks_addon" "this" {
  for_each = var.addon_versions

  cluster_name  = aws_eks_cluster.this.name
  addon_name    = each.key
  addon_version = each.value == "" ? null : each.value

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  tags = local.tags

  depends_on = [aws_eks_node_group.general]
}

# --- access entries --------------------------------------------------------

resource "aws_eks_access_entry" "this" {
  for_each = var.access_entries

  cluster_name      = aws_eks_cluster.this.name
  principal_arn     = each.value.principal_arn
  kubernetes_groups = length(each.value.kubernetes_groups) > 0 ? each.value.kubernetes_groups : null
  type              = "STANDARD"

  tags = local.tags
}

resource "aws_eks_access_policy_association" "this" {
  for_each = var.access_entries

  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value.principal_arn
  policy_arn    = each.value.policy_arn

  access_scope {
    type       = each.value.access_scope_type
    namespaces = each.value.access_scope_type == "namespace" ? each.value.namespaces : null
  }

  depends_on = [aws_eks_access_entry.this]
}
