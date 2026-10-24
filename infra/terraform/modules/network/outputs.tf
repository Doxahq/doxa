output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets, one per availability zone, in zone order."
  value       = [for zone in local.availability_zones : aws_subnet.public[zone].id]
}
