# Offline tests of the private tunnel: the provider is mocked, so nothing
# reaches Cloudflare. Run with `terraform test` in modules/cloudflare-tunnel.

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
  account_id  = "cf-account"
  name        = "doxa-api-test"
  origin_port = 8786
}

run "has_no_public_route_into_the_tunnel" {
  command = apply

  assert {
    condition = length(cloudflare_zero_trust_tunnel_cloudflared_config.this.config.ingress) == 1 && alltrue([
      for rule in cloudflare_zero_trust_tunnel_cloudflared_config.this.config.ingress :
      rule.hostname == null && rule.service == "http_status:404"
    ])
    error_message = "The tunnel must have no public hostname: its only ingress rule refuses every request with 404."
  }

  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.this.config_src == "cloudflare"
    error_message = "Cloudflare must manage the tunnel configuration, so a task cannot add ingress rules."
  }
}

run "routes_the_vpc_service_to_the_api_port_on_loopback_only" {
  command = apply

  assert {
    condition     = cloudflare_connectivity_directory_service.origin.type == "http"
    error_message = "The origin VPC Service must be an HTTP service."
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.origin.host.ipv4 == "127.0.0.1" && cloudflare_connectivity_directory_service.origin.host.hostname == null
    error_message = "cloudflared must reach the API on the task's loopback address, not on a resolvable name."
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.origin.host.network.tunnel_id == cloudflare_zero_trust_tunnel_cloudflared.this.id
    error_message = "The VPC Service must use this module's tunnel."
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.origin.http_port == 8786 && cloudflare_connectivity_directory_service.origin.https_port == null
    error_message = "The VPC Service must open only the API port: no second scheme or port."
  }

  assert {
    condition     = output.vpc_service_id == "5f0c1e2d-0000-4000-8000-000000000000" && output.tunnel_id == "0b6e7d1a-0000-4000-8000-000000000000"
    error_message = "The module must output the IDs of its tunnel and VPC Service."
  }
}

run "rejects_a_port_outside_the_tcp_range" {
  command = plan

  variables {
    origin_port = 70000
  }

  expect_failures = [var.origin_port]
}

run "rejects_a_fractional_port" {
  command = plan

  variables {
    origin_port = 8786.5
  }

  expect_failures = [var.origin_port]
}
