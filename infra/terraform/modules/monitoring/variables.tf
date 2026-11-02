variable "name" {
  description = "Name prefix of the topic, alarms, rule and budget."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster of the watched service."
  type        = string
}

variable "service_name" {
  description = "Watched ECS service."
  type        = string
}

variable "service_arn" {
  description = "ARN of the watched ECS service, for deploy events."
  type        = string
}

variable "alert_emails" {
  description = "Addresses that receive alerts and budget notices."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0 && alltrue([for email in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    error_message = "alert_emails must hold at least one valid email address."
  }
}

variable "cpu_alarm_percent" {
  description = "Average CPU use that raises an alert."
  type        = number
  default     = 80
}

variable "memory_alarm_percent" {
  description = "Average memory use that raises an alert."
  type        = number
  default     = 85
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost limit of the account, in USD. Notices go out at 80% actual and 100% forecast."
  type        = number
  default     = 100
}

variable "daily_pause" {
  description = "Daily window in which the API runs no task on purpose (see the api-service module). The no-running-task alarm is muted then. Null keeps the alarm on all day."
  type = object({
    stop_hour  = number
    start_hour = number
    timezone   = string
  })
  default = null
}

variable "valkey" {
  description = "The Valkey serverless cache to watch, with its hard limits. Sessions and OAuth state live there, so reaching a limit stops sign-in for everyone. Null adds no cache alarms."
  type = object({
    cache_name          = string
    max_data_storage_gb = number
    max_ecpu_per_second = number
  })
  default = null
}

variable "valkey_alarm_percent" {
  description = "Share of a Valkey limit, in percent, that raises an alert."
  type        = number
  default     = 80
}
