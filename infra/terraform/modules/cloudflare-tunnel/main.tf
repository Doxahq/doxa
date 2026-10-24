# A private Cloudflare Tunnel and the Workers VPC Service that the thin
# doxa-api Worker binds to. The cloudflared sidecar of each API task joins the
# tunnel with the tunnel token and opens outbound connections only.
#
# The tunnel has no public hostname and no DNS record, so nothing on the
# internet routes into it. Requests reach the origin only through the VPC
# Service, which only Workers of this account with a binding to it can call.

resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id = var.account_id
  name       = var.name
  config_src = "cloudflare"
}

# Workers VPC needs no ingress rules. Cloudflare requires at least one rule, so
# the only rule refuses everything: a public hostname that someone points at
# this tunnel later gets 404 and never reaches the API.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    ingress = [
      { service = "http_status:404" },
    ]
  }
}

# The origin, as cloudflared sees it: the API port on the loopback address of
# the task, which the sidecar shares with the API container. Only http_port is
# set, so the service accepts no other scheme or port. The tunnel encrypts the
# traffic from Cloudflare to cloudflared.
resource "cloudflare_connectivity_directory_service" "origin" {
  account_id = var.account_id
  name       = var.name
  type       = "http"
  http_port  = var.origin_port

  host = {
    ipv4 = "127.0.0.1"
    network = {
      tunnel_id = cloudflare_zero_trust_tunnel_cloudflared.this.id
    }
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}
