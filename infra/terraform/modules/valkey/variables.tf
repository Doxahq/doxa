variable "name" {
  description = "Name of the serverless cache. Also the prefix of its security group."
  type        = string
}

variable "description" {
  description = "Description of the serverless cache."
  type        = string
  default     = "Key-value store of the Doxa API"
}

variable "vpc_id" {
  description = "VPC of the cache."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets of the cache, in 2 or 3 availability zones."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2 && length(var.subnet_ids) <= 3
    error_message = "ElastiCache Serverless needs subnets in 2 or 3 availability zones."
  }
}

variable "client_security_group_id" {
  description = "Security group of the clients that may connect."
  type        = string
}

variable "major_engine_version" {
  description = "Major Valkey version."
  type        = string
  default     = "8"
}

variable "max_data_storage_gb" {
  description = "Upper limit of stored data, in GB."
  type        = number
  default     = 1
}

variable "max_ecpu_per_second" {
  description = "Upper limit of ElastiCache Processing Units per second."
  type        = number
  default     = 5000
}

variable "daily_snapshot_time" {
  description = "UTC time of the daily snapshot, as HH:MM."
  type        = string
  default     = "07:00"
}

variable "snapshot_retention_days" {
  description = "Days to keep daily snapshots. 0 turns snapshots off."
  type        = number
  default     = 3
}
