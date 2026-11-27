variable "name" {
  description = "Name of the deploy role."
  type        = string
}

variable "repositories" {
  description = <<-EOT
    GitHub repositories whose workflow jobs may take the role, as they appear
    in the OIDC subject: owner/name, or owner@owner-id/name@repo-id for repos
    whose tokens carry immutable IDs (newer repos do). The ID form survives a
    rename. Two entries during a move from one repo to another.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.repositories) > 0 && alltrue([for name in var.repositories : can(regex("^[A-Za-z0-9_.-]+(@[0-9]+)?/[A-Za-z0-9_.-]+(@[0-9]+)?$", name))])
    error_message = "repositories must hold at least one owner/name or owner@id/name@id."
  }
}

variable "environments" {
  description = "GitHub environments whose workflow jobs may take the role. A job with `environment:` gets the OIDC subject repo:<owner/name>:environment:<name>."
  type        = list(string)
  default     = ["production"]

  validation {
    condition     = length(var.environments) > 0 && alltrue([for name in var.environments : can(regex("^[A-Za-z0-9_.-]+$", name))])
    error_message = "environments must hold at least one GitHub environment name."
  }
}

variable "existing_oidc_provider_arn" {
  description = "ARN of a GitHub OIDC provider that already exists in the account. Null creates one."
  type        = string
  default     = null
}

variable "ecr_repository_arn" {
  description = "ECR repository that the role pushes to."
  type        = string
}

variable "ecs_service_arns" {
  description = "ECS services that the role updates: the blue and the green service of the API."
  type        = list(string)
}

variable "task_count_parameter_arn" {
  description = "SSM parameter with the task count of the live color, which the deploy reads."
  type        = string
}

variable "task_role_arns" {
  description = "Execution and task roles that a new task definition revision names."
  type        = list(string)
}
