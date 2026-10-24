terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # 5.13 adds cloudflare_connectivity_directory_service (Workers VPC).
      version = "~> 5.13"
    }
  }
}
