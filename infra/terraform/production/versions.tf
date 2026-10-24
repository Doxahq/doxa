terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source = "cloudflare/cloudflare"
      # 5.13 adds cloudflare_connectivity_directory_service (Workers VPC).
      version = "~> 5.13"
    }
  }

  # State lives in S3 with a lock file. `terraform init -backend-config=backend.hcl`
  # fills in the bucket; see backend.hcl.example.
  backend "s3" {}
}
