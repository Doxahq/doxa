# The Doxa API origin on ECS Fargate, reached through Cloudflare Tunnels.
#
#   caller Workers ─RPC─▶ doxa-api Worker ─ORIGIN_<COLOR> binding (Workers VPC)─▶
#     private tunnel ─▶ cloudflared ─localhost─▶ api (Node) ─▶ Postgres, R2, Valkey
#
# The origin runs as two ECS services, blue and green, each with its own
# tunnel and VPC Service. The edge sends traffic to one of them (ORIGIN_COLOR);
# a release starts the new image on the other and then switches the edge.
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

  # Blue keeps the names of the single service from before blue/green, so it
  # became blue in place. scripts/deploy/lib/release/origin-colors.mjs uses the same rule.
  colors = { blue = local.name, green = "${local.name}-green" }
  # The tunnel token parameter of each color.
  tunnel_token_names = { blue = "TUNNEL_TOKEN", green = "TUNNEL_TOKEN_GREEN" }

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
  source   = "../modules/cloudflare-tunnel"
  for_each = local.colors

  account_id  = var.cloudflare_account_id
  name        = each.value
  origin_port = local.api_port
}

moved {
  from = module.tunnel
  to   = module.tunnel["blue"]
}

resource "aws_ssm_parameter" "tunnel_token" {
  for_each = local.colors

  name        = "${local.ssm_prefix}/${local.tunnel_token_names[each.key]}"
  description = "Token of the ${each.value} Cloudflare Tunnel, for the cloudflared sidecar of the ${each.key} service."
  type        = "SecureString"
  value       = module.tunnel[each.key].token
}

moved {
  from = aws_ssm_parameter.tunnel_token
  to   = aws_ssm_parameter.tunnel_token["blue"]
}

# The task count of the live color. The deploy owns the scaling bounds of
# both colors (the idle one has 0), so it reads them here.
resource "aws_ssm_parameter" "task_count" {
  name        = "${local.ssm_prefix}/deploy/task-count"
  description = "Task count of the live API color, read by scripts/deploy/deploy-api-ecs.mjs."
  type        = "String"
  value       = jsonencode({ min = var.min_task_count, max = var.max_task_count })
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
  colors     = local.colors
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.public_subnet_ids

  cpu_units = var.cpu_units
  memory_mb = var.memory_mb

  api_image       = var.api_image
  api_port        = local.api_port
  api_environment = local.api_environment
  api_secrets     = local.api_secrets

  tunnel_token_parameter_arns = { for color, parameter in aws_ssm_parameter.tunnel_token : color => parameter.arn }

  min_task_count = var.min_task_count
  max_task_count = var.max_task_count

  log_retention_days = var.log_retention_days

  enable_execute_command = var.enable_execute_command
}

module "github_deploy" {
  source = "../modules/github-deploy"

  name                       = "${local.name}-github-deploy"
  repositories               = var.github_repositories
  existing_oidc_provider_arn = var.github_oidc_provider_arn
  ecr_repository_arn         = module.container_registry.repository_arn
  ecs_service_arns           = values(module.api_service.service_arns)
  task_count_parameter_arn   = aws_ssm_parameter.task_count.arn
  task_role_arns             = [module.api_service.execution_role_arn, module.api_service.task_role_arn]
}

module "monitoring" {
  source = "../modules/monitoring"

  name               = local.name
  cluster_name       = module.api_service.cluster_name
  alert_emails       = var.alert_emails
  monthly_budget_usd = var.monthly_budget_usd

  services = {
    for color, name in module.api_service.service_names : color => { name = name, arn = module.api_service.service_arns[color] }
  }

  # Null leaves the module default in place.
  budget_notifications = var.budget_notifications

  valkey = {
    cache_name          = module.valkey.cache_name
    max_data_storage_gb = module.valkey.max_data_storage_gb
    max_ecpu_per_second = module.valkey.max_ecpu_per_second
  }
}
