# ElastiCache Serverless for Valkey: the API's key-value store in place of the
# AUTH_KV and OAUTH_KV namespaces. Serverless Valkey bills a 100 MB minimum
# (about $6 a month) and always encrypts traffic, so clients use rediss://.
# Only the security group of the API tasks can connect.

locals {
  # ElastiCache Serverless serves writes on 6379 and replica reads on 6380.
  endpoint_ports = { primary = 6379, reader = 6380 }
}

resource "aws_security_group" "this" {
  name        = "${var.name}-valkey"
  description = "Valkey: accepts connections from the API tasks only"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name}-valkey" }
}

resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each = local.endpoint_ports

  security_group_id            = aws_security_group.this.id
  description                  = "Valkey ${each.key} endpoint from the API tasks"
  referenced_security_group_id = var.client_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

resource "aws_elasticache_serverless_cache" "this" {
  name                 = var.name
  description          = var.description
  engine               = "valkey"
  major_engine_version = var.major_engine_version
  subnet_ids           = var.subnet_ids
  security_group_ids   = [aws_security_group.this.id]

  daily_snapshot_time      = var.daily_snapshot_time
  snapshot_retention_limit = var.snapshot_retention_days

  # Hard caps that bound the bill if a bug writes or reads in a loop.
  cache_usage_limits {
    data_storage {
      maximum = var.max_data_storage_gb
      unit    = "GB"
    }

    ecpu_per_second {
      maximum = var.max_ecpu_per_second
    }
  }
}
