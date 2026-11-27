variable "name" {
  description = "Name prefix of the topic, alarms, rule and budget."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster of the watched service."
  type        = string
}

variable "services" {
  description = "The blue/green ECS services of the API: color => { name, arn }. One of them serves at a time."
  type = map(object({
    name = string
    arn  = string
  }))

  validation {
    condition     = length(var.services) > 0
    error_message = "services must name at least one ECS service."
  }
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
  description = "Monthly AWS cost limit of the account, in USD. Notices go out at the levels of budget_notifications."
  type        = number
  default     = 100
}

variable "budget_notifications" {
  description = "Budget notices to alert_emails: the cost they compare (ACTUAL or FORECASTED) and the share of monthly_budget_usd, in percent, that sends one."
  type = list(object({
    type              = string
    threshold_percent = number
  }))
  default = [
    { type = "ACTUAL", threshold_percent = 80 },
    { type = "FORECASTED", threshold_percent = 100 },
  ]
  # A null input (the production stack's default) takes the default above.
  nullable = false

  validation {
    condition     = length(var.budget_notifications) > 0 && alltrue([for notice in var.budget_notifications : contains(["ACTUAL", "FORECASTED"], notice.type) && notice.threshold_percent > 0])
    error_message = "budget_notifications must hold at least one notice, each with type ACTUAL or FORECASTED and a threshold_percent above 0."
  }
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
