locals {
  api_container_name    = "api"
  tunnel_container_name = "cloudflared"

  secret_parameter_arns = distinct(concat(values(var.api_secrets), [var.tunnel_token_parameter_arn]))

  # Node is in every API image, and a fetch needs no curl or wget in the image.
  api_health_url = "http://127.0.0.1:${var.api_port}${var.api_health_check_path}"
  api_health_probe = join("", [
    "fetch('${local.api_health_url}', { signal: AbortSignal.timeout(4000) })",
    ".then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))",
  ])

  # cloudflared needs a little longer than its grace period to close the tunnel.
  tunnel_stop_timeout_seconds = var.tunnel_grace_period_seconds + 5

  api_container = {
    name      = local.api_container_name
    image     = var.api_image
    essential = true

    environment = [for name in sort(keys(var.api_environment)) : { name = name, value = var.api_environment[name] }]
    secrets     = [for name in sort(keys(var.api_secrets)) : { name = name, valueFrom = var.api_secrets[name] }]

    healthCheck = {
      command     = ["CMD", "node", "-e", local.api_health_probe]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }

    stopTimeout = var.api_stop_timeout_seconds

    # Runs an init process as PID 1 that forwards SIGTERM to Node and reaps
    # child processes. ECS Exec also needs it.
    linuxParameters = { initProcessEnabled = true }

    logConfiguration = local.log_configuration[local.api_container_name]
  }

  tunnel_container = {
    name      = local.tunnel_container_name
    image     = var.cloudflared_image
    essential = true
    # Workers VPC works only over QUIC (outbound UDP 7844). With "auto",
    # cloudflared falls back to HTTP/2 and the VPC Service stops working, so
    # pin QUIC and let a blocked QUIC fail at the start, in the logs.
    command = ["tunnel", "--no-autoupdate", "--protocol", "quic", "--grace-period", "${var.tunnel_grace_period_seconds}s", "run"]

    # cloudflared reads the token from TUNNEL_TOKEN.
    secrets = [{ name = "TUNNEL_TOKEN", valueFrom = var.tunnel_token_parameter_arn }]

    # Join the tunnel only when the API answers. At shutdown ECS stops this
    # container first, so the tunnel drains before the API gets SIGTERM.
    dependsOn = [{ containerName = local.api_container_name, condition = "HEALTHY" }]

    stopTimeout      = local.tunnel_stop_timeout_seconds
    logConfiguration = local.log_configuration[local.tunnel_container_name]
  }

  log_configuration = {
    for container in [local.api_container_name, local.tunnel_container_name] : container => {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = container
        # Never block the API on a slow log write.
        "mode"            = "non-blocking"
        "max-buffer-size" = "4m"
      }
    }
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu_units)
  memory                   = tostring(var.memory_mb)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([local.api_container, local.tunnel_container])

  # The deploy script registers later revisions of this family. Keep old
  # revisions when Terraform registers a new one, so rollbacks can use them.
  skip_destroy = true
}
