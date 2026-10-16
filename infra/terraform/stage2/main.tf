# Stage 2: the "real" AWS layout, sized for credits and meant to be switched on
# for a demo and destroyed after (scripts/demo.ps1 stage2 up | pause | resume | down).
#
#   CloudFront (HTTPS) ─┬─ /products/* ─▶ S3 (product images, private + OAC)
#                       └─ everything  ─▶ ALB (CloudFront-only) ─▶ ECS Fargate x7
#   ECS ─▶ RDS PostgreSQL (private) · ElastiCache Redis (private)
#       ─▶ data box EC2: Kafka + Mongo + Jaeger + Mailpit (MSK/DocumentDB need a paid plan)
#   Cloud Map private DNS: <service>.shopflow.local · CloudWatch Logs + alarms ─▶ SNS email
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "shopflow-tfstate-649320110403"
    key          = "stage2/terraform.tfstate"
    region       = "ap-southeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "shopflow", Stage = "stage2", ManagedBy = "terraform" } }
}

variable "region" {
  type    = string
  default = "ap-southeast-2"
}

variable "image_tag" {
  type        = string
  description = "Git SHA of the images in ECR (scripts/demo.ps1 picks the newest)"
}

variable "alert_email" {
  type        = string
  description = "CloudWatch alarms are emailed here (confirm the SNS email once)"
}

variable "desired_count" {
  type    = number
  default = 1 # tasks per service; demo.ps1 pause/resume scales 0 <-> 1 outside Terraform
}

variable "data_instance_type" {
  type    = string
  default = "c7i-flex.large" # free-tier eligible, 4 GiB: Kafka + Mongo + Jaeger + Mailpit
}

data "aws_caller_identity" "me" {}
data "aws_availability_zones" "available" { state = "available" }

locals {
  name       = "shopflow-stage2"
  account_id = data.aws_caller_identity.me.account_id
  registry   = "${data.aws_caller_identity.me.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)
  ssm_prefix = "/shopflow/prod" # same JWT keys / tokens as Stage 1 (scripts/put-stage1-secrets.ps1)
  ns         = "shopflow.local"
}
