# Default VPC + its public subnets: free, and enough for one box.
data "aws_vpc" "default" { default = true }

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Only 80 (ACME challenge + redirect) and 443 are open. No 22: we use SSM.
resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "ShopFlow stage1: HTTP/HTTPS in, all out"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (LetsEncrypt challenge, redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    # Accepted: a public web server must be reachable on 80/443.
    #trivy:ignore:AWS-0107
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    # Accepted: a public web server must be reachable on 80/443.
    #trivy:ignore:AWS-0107
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "Pull images, LetsEncrypt, DuckDNS, OS updates"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    # Accepted: the box needs internet egress (no NAT / VPC endpoints on Stage 1).
    #trivy:ignore:AWS-0104
    cidr_blocks = ["0.0.0.0/0"]
  }
}
