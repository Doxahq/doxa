variable "name" {
  description = "Name prefix for the VPC and its resources."
  type        = string
}

variable "cidr_block" {
  description = "IPv4 range of the VPC."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.cidr_block, 0))
    error_message = "cidr_block must be a valid IPv4 CIDR range."
  }
}

variable "availability_zone_count" {
  description = "Number of availability zones, one public subnet in each. ElastiCache Serverless needs at least 2."
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 3
    error_message = "availability_zone_count must be 2 or 3."
  }
}

variable "subnet_newbits" {
  description = "Bits added to the VPC prefix for each subnet. 8 turns a /16 into /24 subnets."
  type        = number
  default     = 8
}
