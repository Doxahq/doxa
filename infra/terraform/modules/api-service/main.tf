# The API on ECS Fargate, as two services: blue and green (see service.tf).
# Each task runs two containers that share localhost:
#
#   api          the Node server of apps/api
#   cloudflared  joins the Cloudflare Tunnel and forwards requests to the api
#
# No load balancer: requests arrive through the tunnel, so the tasks accept no
# inbound traffic. Container health checks replace load balancer checks, and
# autoscaling follows CPU.

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  # Valid Fargate memory sizes (MiB) for each CPU size (units).
  fargate_memory_options_mb = {
    "256"   = [512, 1024, 2048]
    "512"   = range(1024, 4097, 1024)
    "1024"  = range(2048, 8193, 1024)
    "2048"  = range(4096, 16385, 1024)
    "4096"  = range(8192, 30721, 1024)
    "8192"  = range(16384, 61441, 4096)
    "16384" = range(32768, 122881, 8192)
  }

  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  # Container Insights adds about $10 a month at this size; the service
  # metrics in AWS/ECS cover the alarms.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
}
