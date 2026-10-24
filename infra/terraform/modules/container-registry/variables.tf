variable "name" {
  description = "Name of the ECR repository."
  type        = string
}

variable "retained_image_count" {
  description = "Number of images to keep. Older images expire, so rollbacks reach this many deploys back."
  type        = number
  default     = 30

  validation {
    condition     = var.retained_image_count >= 5
    error_message = "retained_image_count must be at least 5, to keep rollback targets."
  }
}

variable "untagged_image_expiry_days" {
  description = "Days after which an untagged image expires."
  type        = number
  default     = 7
}
