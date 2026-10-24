provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "doxa"
      Service     = "api"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Reads the API token from CLOUDFLARE_API_TOKEN. The token needs the account
# permissions Cloudflare Tunnel: Edit and Connectivity Directory (write), for
# the Workers VPC Service. It needs no zone permission.
provider "cloudflare" {}
