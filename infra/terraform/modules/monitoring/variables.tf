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
