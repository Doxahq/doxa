# Offline tests of the production stack: both providers are mocked, so
# nothing reaches AWS or Cloudflare. Run with `terraform test` in production.

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

  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1c", "us-east-1a", "us-east-1b"] }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/doxa-api-test-role" }
  }

  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:doxa-api-test-alerts" }
  }

  mock_resource "aws_elasticache_serverless_cache" {
    defaults = {
      endpoint = [{ address = "doxa-api-test.serverless.use1.cache.amazonaws.com", port = 6379 }]
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api" }
  }
}

mock_provider "cloudflare" {
  mock_resource "cloudflare_zero_trust_tunnel_cloudflared" {
    defaults = { id = "0b6e7d1a-0000-4000-8000-000000000000" }
  }

  mock_resource "cloudflare_connectivity_directory_service" {
    defaults = { service_id = "5f0c1e2d-0000-4000-8000-000000000000" }
  }

  mock_data "cloudflare_zero_trust_tunnel_cloudflared_token" {
    defaults = { token = "test-tunnel-token" }
  }
}

variables {
  environment           = "test"
  cloudflare_account_id = "cf-account"
  github_repositories   = ["acme/app", "acme@101/app-ops@202"]
  api_image             = "123456789012.dkr.ecr.us-east-1.amazonaws.com/doxa-api:abc1234"
  alert_emails          = ["alerts@example.com"]
  api_secret_names      = ["DATABASE_URL", "BETTER_AUTH_SECRET"]
  api_environment       = { WEB_ORIGIN = "https://doxa.so" }
}

run "wires_the_stack_together" {
  command = apply

  assert {
    condition     = output.origin_vpc_service_ids == { blue = "5f0c1e2d-0000-4000-8000-000000000000", green = "5f0c1e2d-0000-4000-8000-000000000000" }
    error_message = "The stack must output the VPC Service ID of each color, for the ORIGIN_BLUE and ORIGIN_GREEN bindings of the thin Worker."
  }

  assert {
    condition     = module.tunnel["blue"].tunnel_id == "0b6e7d1a-0000-4000-8000-000000000000"
    error_message = "The VPC Service and the cloudflared token must use the stack's tunnel."
  }

  assert {
    condition     = output.service_names == { blue = "doxa-api-test", green = "doxa-api-test-green" } && output.task_definition_families.blue == "doxa-api-test"
    error_message = "Resource names must carry the environment, and blue must keep the names from before blue/green."
  }

  assert {
    condition     = aws_ssm_parameter.tunnel_token["blue"].name == "/doxa/api/test/TUNNEL_TOKEN" && aws_ssm_parameter.tunnel_token["green"].name == "/doxa/api/test/TUNNEL_TOKEN_GREEN" && aws_ssm_parameter.tunnel_token["green"].type == "SecureString"
    error_message = "Each tunnel token must be a SecureString next to the API secrets, and blue must keep its name."
  }

  assert {
    condition     = module.tunnel["green"].tunnel_id != null && length(module.tunnel) == 2
    error_message = "Each color must have its own tunnel."
  }

  assert {
    condition     = aws_ssm_parameter.task_count.name == "/doxa/api/test/deploy/task-count" && jsondecode(aws_ssm_parameter.task_count.value) == { min = 1, max = 1 }
    error_message = "The deploy reads the task count of the live color from this parameter."
  }

  assert {
    condition     = local.api_secrets["DATABASE_URL"] == "arn:aws:ssm:us-east-1:123456789012:parameter/doxa/api/test/DATABASE_URL"
    error_message = "Each secret name must map to its parameter under the environment's SSM path."
  }

  assert {
    condition     = local.api_environment["VALKEY_URL"] == "rediss://doxa-api-test.serverless.use1.cache.amazonaws.com:6379"
    error_message = "The API must reach Valkey over TLS at the cache endpoint."
  }

  assert {
    condition     = local.api_environment["PORT"] == "8786" && local.api_environment["WEB_ORIGIN"] == "https://doxa.so"
    error_message = "The API environment must merge the given variables with the stack's own."
  }

  assert {
    condition     = local.api_environment["NODE_OPTIONS"] == "--max-old-space-size=2880"
    error_message = "A 4 GB task must give V8 a 2880 MB heap."
  }
}

run "rejects_variables_that_the_stack_sets" {
  command = plan

  variables {
    api_environment = { PORT = "3000" }
  }

  expect_failures = [var.api_environment]
}

run "rejects_the_tunnel_token_as_an_api_secret" {
  command = plan

  variables {
    api_secret_names = ["TUNNEL_TOKEN"]
  }

  expect_failures = [var.api_secret_names]
}
