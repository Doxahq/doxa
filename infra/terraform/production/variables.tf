variable "aws_region" {
  description = "AWS region. us-east-1 is next to the PlanetScale database."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name, used in resource names and the SSM path."
  type        = string
  default     = "production"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "environment must be lowercase letters, digits and dashes."
  }
}

# --- Cloudflare ---

variable "cloudflare_account_id" {
  description = "Cloudflare account of the tunnel, the VPC Service and the thin doxa-api Worker."
  type        = string
}

# --- API task ---

variable "api_image" {
  description = "Image of the first deploy, as <repository_url>:<tag>. Later deploys go through scripts/deploy-api-ecs.mjs."
  type        = string
}

variable "cpu_units" {
  description = "Task CPU in units (1024 = 1 vCPU)."
  type        = number
  default     = 2048
}

variable "memory_mb" {
  description = "Task memory in MiB."
  type        = number
  default     = 4096
}

variable "min_task_count" {
  description = "Least number of running tasks."
  type        = number
  default     = 1
}

variable "max_task_count" {
  description = "Largest number of running tasks. Equal to min_task_count turns autoscaling off."
  type        = number
  default     = 1
}

variable "daily_pause" {
  description = "Daily window with no running API task, to save cost before launch. Hours are local to timezone. Null runs the API all day."
  type = object({
    stop_hour  = number
    start_hour = number
    timezone   = string
  })
  default = null
}

variable "api_environment" {
  description = "Plain environment variables of the API. PORT and VALKEY_URL come from this stack."
  type        = map(string)
  default     = {}

  validation {
    condition     = length(setintersection(keys(var.api_environment), ["PORT", "VALKEY_URL"])) == 0
    error_message = "api_environment must not set PORT or VALKEY_URL: this stack sets them."
  }
}

variable "api_secret_names" {
  description = "Names of the API's secret environment variables. Each one is an SSM SecureString at /doxa/api/<environment>/<NAME>, written outside Terraform."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for name in var.api_secret_names : can(regex("^[A-Z][A-Z0-9_]*$", name))])
    error_message = "api_secret_names must be environment variable names in UPPER_SNAKE_CASE."
  }

  validation {
    condition     = !contains(var.api_secret_names, "TUNNEL_TOKEN")
    error_message = "TUNNEL_TOKEN is the tunnel's own secret, which this stack writes."
  }
}

# --- Deploys and alerts ---

variable "github_repositories" {
  description = "GitHub repositories whose Actions may deploy, as in the OIDC subject: owner/name or owner@owner-id/name@repo-id. The ops repo runs the production deploys."
  type        = list(string)
}

variable "github_oidc_provider_arn" {
  description = "ARN of the account's GitHub OIDC provider, if one exists. Null creates it."
  type        = string
  default     = null
}

variable "alert_emails" {
  description = "Addresses that receive alerts and budget notices."
  type        = list(string)
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost limit of the account, in USD."
  type        = number
  default     = 120
}
