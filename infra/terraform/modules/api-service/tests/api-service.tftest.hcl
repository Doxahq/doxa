# Offline tests: the AWS provider is mocked, so nothing reaches AWS.
# Run with `terraform test` in modules/api-service.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }

  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/doxa-api-test-role" }
  }
}

variables {
  name                       = "doxa-api-test"
  vpc_id                     = "vpc-0123456789abcdef0"
  subnet_ids                 = ["subnet-a", "subnet-b"]
  api_image                  = "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:abc1234"
  tunnel_token_parameter_arn = "arn:aws:ssm:us-east-1:123456789012:parameter/doxa/api/test/TUNNEL_TOKEN"
  api_environment            = { WEB_ORIGIN = "https://doxa.so", BETTER_AUTH_URL = "https://api.doxa.so" }
  api_secrets = {
    DATABASE_URL = "arn:aws:ssm:us-east-1:123456789012:parameter/doxa/api/test/DATABASE_URL"
  }
}

run "task_runs_the_api_and_the_tunnel_side_by_side" {
  command = apply

  assert {
    condition     = [for container in jsondecode(aws_ecs_task_definition.this.container_definitions) : container.name] == ["api", "cloudflared"]
    error_message = "The task must run the api container and the cloudflared container."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[1].dependsOn == [{ containerName = "api", condition = "HEALTHY" }]
    error_message = "cloudflared must start only after the api container is healthy."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[1].secrets == [{ name = "TUNNEL_TOKEN", valueFrom = var.tunnel_token_parameter_arn }]
    error_message = "cloudflared must read its token from the tunnel token parameter."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[0].stopTimeout == 120
    error_message = "The api container must get the full Fargate stop timeout to drain background tasks."
  }

  assert {
    condition     = join(" ", jsondecode(aws_ecs_task_definition.this.container_definitions)[1].command) == "tunnel --no-autoupdate --protocol quic --grace-period 25s run"
    error_message = "cloudflared must use QUIC: Workers VPC does not work over the HTTP/2 fallback."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this.container_definitions)[1].stopTimeout == 30
    error_message = "cloudflared must stop 5 seconds after its 25-second grace period."
  }

  assert {
    condition     = [for variable in jsondecode(aws_ecs_task_definition.this.container_definitions)[0].environment : variable.name] == ["BETTER_AUTH_URL", "WEB_ORIGIN"]
    error_message = "Environment variables must be sorted by name, so the task definition does not change between plans."
  }

  assert {
    condition     = strcontains(jsondecode(aws_ecs_task_definition.this.container_definitions)[0].healthCheck.command[3], "http://127.0.0.1:8786/health")
    error_message = "The health check must probe the API port and health path."
  }

  assert {
    condition     = aws_ecs_task_definition.this.cpu == "2048" && aws_ecs_task_definition.this.memory == "4096"
    error_message = "The default task size must be 2 vCPU and 4 GB."
  }

  assert {
    condition     = one(aws_ecs_task_definition.this.runtime_platform).cpu_architecture == "ARM64"
    error_message = "The default architecture must be ARM64."
  }

  assert {
    condition     = length(aws_ecs_service.this.load_balancer) == 0
    error_message = "The service must not use a load balancer: requests arrive through the tunnel."
  }

  assert {
    condition     = one(aws_ecs_service.this.network_configuration).assign_public_ip
    error_message = "Tasks need a public IP for outbound traffic, because the VPC has no NAT gateway."
  }

  assert {
    condition     = one(aws_ecs_service.this.deployment_circuit_breaker).rollback
    error_message = "A failed deploy must roll back."
  }

  assert {
    condition     = length(aws_security_group.tasks.ingress) == 0
    error_message = "The task security group must accept no inbound traffic."
  }
}

run "rejects_a_memory_size_that_fargate_does_not_offer" {
  command = plan

  variables {
    cpu_units = 2048
    memory_mb = 2048
  }

  expect_failures = [var.memory_mb]
}

run "rejects_an_unpinned_cloudflared_image" {
  command = plan

  variables {
    cloudflared_image = "cloudflare/cloudflared:latest"
  }

  expect_failures = [var.cloudflared_image]
}

run "rejects_a_maximum_below_the_minimum" {
  command = plan

  variables {
    min_task_count = 2
    max_task_count = 1
  }

  expect_failures = [var.max_task_count]
}

run "rejects_a_stop_timeout_above_the_fargate_limit" {
  command = plan

  variables {
    api_stop_timeout_seconds = 300
  }

  expect_failures = [var.api_stop_timeout_seconds]
}
