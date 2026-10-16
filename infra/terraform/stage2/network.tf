# Own VPC, 2 AZs. NO NAT gateway (~$35/month): tasks and the data box sit in public
# subnets with a public IP (to pull images / reach AWS APIs) but their security groups
# only accept traffic from inside. RDS and Redis are in private subnets with no route out.
resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true # Cloud Map private DNS needs both
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.${count.index}.0/24"
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.${count.index + 10}.0/24"
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private subnets keep the VPC's main route table: local traffic only.

# ---------------- security groups ----------------
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: HTTP from CloudFront edge only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "CloudFront origin-facing IPs only"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    description = "To ECS tasks in the VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS tasks: from the ALB and from each other"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "Gateway HTTP from the ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  ingress {
    description = "Service to service (HTTP 3000, gRPC 50052)"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    self        = true
  }
  egress {
    description = "ECR, SSM, Secrets Manager, CloudWatch (no NAT: via public IP)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    # Accepted: no NAT / VPC endpoints on a credit budget.
    #trivy:ignore:AWS-0104
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "data" {
  name        = "${local.name}-data"
  description = "Data box: Kafka, Mongo, OTLP, SMTP from ECS tasks only"
  vpc_id      = aws_vpc.main.id
  dynamic "ingress" {
    for_each = { kafka = 9092, mongo = 27017, otlp = 4318, smtp = 1025 }
    content {
      description     = "${ingress.key} from ECS tasks"
      from_port       = ingress.value
      to_port         = ingress.value
      protocol        = "tcp"
      security_groups = [aws_security_group.tasks.id]
    }
  }
  egress {
    description = "Pull images, OS updates, SSM"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    # Accepted: no NAT / VPC endpoints on a credit budget.
    #trivy:ignore:AWS-0104
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "RDS + Redis: from ECS tasks only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "Postgres from ECS tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
  ingress {
    description     = "Redis from ECS tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}
