# A VPC with public subnets only. The API tasks reach the internet through the
# internet gateway with a public IP each, so the VPC needs no NAT gateway
# (about $33 a month). Nothing in the VPC accepts inbound internet traffic:
# requests reach the API through the Cloudflare Tunnel, which the task opens.

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  availability_zones = slice(sort(data.aws_availability_zones.available.names), 0, var.availability_zone_count)
  subnet_indexes     = { for index, zone in local.availability_zones : zone => index }
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

# Without rules, the default security group blocks all traffic. Nothing uses it.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-default-unused" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = var.name }
}

resource "aws_subnet" "public" {
  for_each = local.subnet_indexes

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.cidr_block, var.subnet_newbits, each.value)

  # ECS assigns the public IP per task; other resources in these subnets get none.
  map_public_ip_on_launch = false

  tags = { Name = "${var.name}-public-${each.key}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-public" }
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}
