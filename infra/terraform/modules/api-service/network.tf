# The tasks open every connection themselves: the tunnel to Cloudflare, and
# Postgres, R2, Valkey, ECR and the logs endpoint. So the security group has
# outbound rules only.

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "API tasks: outbound only, requests arrive through the tunnel"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name}-tasks" }
}

resource "aws_vpc_security_group_egress_rule" "tasks_all_ipv4" {
  security_group_id = aws_security_group.tasks.id
  description       = "All outbound IPv4 traffic"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
