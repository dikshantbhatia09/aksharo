output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "VPC CIDR. The Helm chart uses it as the in-VPC egress allow-list in its network policies."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet ids, in availability-zone order."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet ids, in availability-zone order. EKS nodes live here."
  value       = aws_subnet.private[*].id
}

output "database_subnet_ids" {
  description = "Database subnet ids, in availability-zone order."
  value       = aws_subnet.database[*].id
}

output "nat_public_ips" {
  description = "Public IPs of the NAT gateways: the addresses to hand a provider that IP-allow-lists callers."
  value       = aws_eip.nat[*].public_ip
}

output "availability_zones" {
  description = "Availability zones this VPC spans."
  value       = var.azs
}
