output "tunnel_id" {
  description = "ID of the tunnel."
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "vpc_service_id" {
  description = "ID of the Workers VPC Service, for the ORIGIN binding of the thin Worker."
  value       = cloudflare_connectivity_directory_service.origin.service_id
}

output "token" {
  description = "Token that cloudflared runs the tunnel with."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  sensitive   = true
}
