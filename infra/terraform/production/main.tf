# The Doxa API origin on ECS Fargate, reached through a Cloudflare Tunnel.
#
#   caller Workers ─RPC─▶ doxa-api Worker ─ORIGIN binding (Workers VPC)─▶
#     private tunnel ─▶ cloudflared ─localhost─▶ api (Node) ─▶ Postgres, R2, Valkey
#
# The origin has no public hostname. The tasks accept no inbound connections.
#
# See infra/terraform/README.md for the first apply and day-to-day work.

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name       = "doxa-api-${var.environment}"
  ssm_prefix = "/doxa/api/${var.environment}"
  api_port   = 8786

  parameter_arn_prefix = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}"
  api_secrets          = { for name in var.api_secret_names : name => "${local.parameter_arn_prefix}/${name}" }

  # Leave room for cloudflared and Node's memory outside the V8 heap.
  api_heap_mb = floor((var.memory_mb - 256) * 0.75)

  api_environment = merge(
    {
      NODE_ENV     = "production"
      NODE_OPTIONS = "--max-old-space-size=${local.api_heap_mb}"
    },
    var.api_environment,
    {
      PORT       = tostring(local.api_port)
      VALKEY_URL = module.valkey.url
    },
  )
}

module "network" {
  source = "../modules/network"

  name = local.name
}

module "container_registry" {
  source = "../modules/container-registry"

  name = "doxa-api"
}

module "tunnel" {
  source      = "../modules/cloudflare-tunnel"
  account_id  = var.cloudflare_account_id
  name        = local.name
  origin_port = local.api_port
}

resource "aws_ssm_parameter" "tunnel_token" {
  name        = "${local.ssm_prefix}/TUNNEL_TOKEN"
  description = "Token of the ${local.name} Cloudflare Tunnel, for the cloudflared sidecar."
  type        = "SecureString"
  value       = module.tunnel.token
}

module "valkey" {
  source = "../modules/valkey"

  name                     = local.name
  vpc_id                   = module.network.vpc_id
  subnet_ids               = module.network.public_subnet_ids
  client_security_group_id = module.api_service.security_group_id
}

module "api_service" {
  source = "../modules/api-service"

  name       = local.name
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.public_subnet_ids

  cpu_units = var.cpu_units
  memory_mb = var.memory_mb

  api_image       = var.api_image
  api_port        = local.api_port
  api_environment = local.api_environment
  api_secrets     = local.api_secrets

  tunnel_token_parameter_arn = aws_ssm_parameter.tunnel_token.arn

  min_task_count = var.min_task_count
  max_task_count = var.max_task_count
  daily_pause    = var.daily_pause
}

module "github_deploy" {
  source = "../modules/github-deploy"

  name                       = "${local.name}-github-deploy"
  repositories               = var.github_repositories
  existing_oidc_provider_arn = var.github_oidc_provider_arn
  ecr_repository_arn         = module.container_registry.repository_arn
  ecs_service_arn            = module.api_service.service_arn
  task_role_arns             = [module.api_service.execution_role_arn, module.api_service.task_role_arn]
}

module "monitoring" {
  source = "../modules/monitoring"

  name               = local.name
  cluster_name       = module.api_service.cluster_name
  service_name       = module.api_service.service_name
  service_arn        = module.api_service.service_arn
  alert_emails       = var.alert_emails
  monthly_budget_usd = var.monthly_budget_usd
  daily_pause        = var.daily_pause
}
