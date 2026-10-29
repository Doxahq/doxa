variable "name" {
  description = "Name of the cluster, service, task family, roles and log group."
  type        = string
}

# --- Network ---

variable "vpc_id" {
  description = "VPC of the tasks."
  type        = string
}

variable "subnet_ids" {
  description = "Public subnets for the tasks. Each task gets a public IP for outbound traffic only."
  type        = list(string)
}

# --- Task size ---

variable "cpu_units" {
  description = "Task CPU in units (1024 = 1 vCPU). Both containers share it."
  type        = number
  default     = 2048

  validation {
    condition     = contains(keys(local.fargate_memory_options_mb), tostring(var.cpu_units))
    error_message = "cpu_units must be a Fargate size: 256, 512, 1024, 2048, 4096, 8192 or 16384."
  }
}

variable "memory_mb" {
  description = "Task memory in MiB. Both containers share it."
  type        = number
  default     = 4096

  validation {
    condition     = contains(lookup(local.fargate_memory_options_mb, tostring(var.cpu_units), []), var.memory_mb)
    error_message = "memory_mb is not a valid Fargate memory size for the chosen cpu_units."
  }
}

variable "cpu_architecture" {
  description = "CPU architecture of the images: ARM64 (Graviton, about 20% cheaper) or X86_64."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

# --- API container ---

variable "api_image" {
  description = "API image for the task definition that Terraform registers. The deploy script registers later revisions with new images."
  type        = string
}

variable "api_port" {
  description = "Port that the API listens on inside the task."
  type        = number
  default     = 8786
}

variable "api_health_check_path" {
  description = "Path that answers 2xx when the API can serve requests."
  type        = string
  default     = "/health"

  validation {
    condition     = startswith(var.api_health_check_path, "/")
    error_message = "api_health_check_path must start with /."
  }
}

variable "api_environment" {
  description = "Plain environment variables of the API container."
  type        = map(string)
  default     = {}
}

variable "api_secrets" {
  description = "Secret environment variables of the API container: variable name => SSM parameter ARN."
  type        = map(string)
  default     = {}
}

variable "api_stop_timeout_seconds" {
  description = "Time between SIGTERM and SIGKILL for the API, to finish background tasks. Fargate allows up to 120."
  type        = number
  default     = 120

  validation {
    condition     = var.api_stop_timeout_seconds >= 2 && var.api_stop_timeout_seconds <= 120
    error_message = "api_stop_timeout_seconds must be between 2 and 120 on Fargate."
  }
}

# --- Tunnel container ---

variable "cloudflared_image" {
  description = "cloudflared image, pinned to a version."
  type        = string
  default     = "cloudflare/cloudflared:2026.10.3"

  validation {
    condition     = !endswith(var.cloudflared_image, ":latest") && strcontains(var.cloudflared_image, ":")
    error_message = "cloudflared_image must name a pinned version tag, not latest."
  }
}

variable "tunnel_token_parameter_arn" {
  description = "ARN of the SSM SecureString that holds the tunnel token."
  type        = string
}

variable "tunnel_grace_period_seconds" {
  description = "Time that cloudflared waits for open requests after SIGTERM."
  type        = number
  default     = 25

  validation {
    condition     = var.tunnel_grace_period_seconds >= 1 && var.tunnel_grace_period_seconds <= 110
    error_message = "tunnel_grace_period_seconds must be between 1 and 110, so that the stop timeout stays within 120."
  }
}

# --- Scaling and deploys ---

variable "min_task_count" {
  description = "Least number of running tasks."
  type        = number
  default     = 1

  validation {
    condition     = var.min_task_count >= 1
    error_message = "min_task_count must be at least 1: with 0 tasks the API is down."
  }
}

variable "max_task_count" {
  description = "Largest number of running tasks. Equal to min_task_count turns autoscaling off."
  type        = number
  default     = 1

  validation {
    condition     = var.max_task_count >= var.min_task_count
    error_message = "max_task_count must be at least min_task_count."
  }
}

variable "daily_pause" {
  description = "Daily window with no running task, to save cost: the service stops at stop_hour and starts again at start_hour. Both are whole hours in timezone, an IANA name such as Africa/Algiers. Null runs the service all day."
  type = object({
    stop_hour  = number
    start_hour = number
    timezone   = string
  })
  default = null

  validation {
    condition = var.daily_pause == null ? true : (
      alltrue([for hour in [var.daily_pause.stop_hour, var.daily_pause.start_hour] : hour == floor(hour) && hour >= 0 && hour <= 23])
      && var.daily_pause.stop_hour != var.daily_pause.start_hour
      && length(var.daily_pause.timezone) > 0
    )
    error_message = "daily_pause needs two different whole hours from 0 to 23 and a timezone."
  }
}

variable "cpu_target_percent" {
  description = "Average CPU use that autoscaling keeps the service at."
  type        = number
  default     = 60
}

variable "enable_execute_command" {
  description = "Allow `aws ecs execute-command` into the API container."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Days to keep container logs."
  type        = number
  default     = 30
}
