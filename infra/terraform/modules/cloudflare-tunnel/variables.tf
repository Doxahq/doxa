variable "account_id" {
  description = "Cloudflare account that owns the tunnel and the VPC Service."
  type        = string
}

variable "name" {
  description = "Name of the tunnel and of the VPC Service."
  type        = string
}

variable "origin_port" {
  description = "Port of the API inside the task. cloudflared reaches it on 127.0.0.1."
  type        = number

  validation {
    condition     = var.origin_port == floor(var.origin_port) && var.origin_port >= 1 && var.origin_port <= 65535
    error_message = "origin_port must be a whole number from 1 to 65535."
  }
}
