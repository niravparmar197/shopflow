# Stage 1: the whole ShopFlow stack on ONE free-tier EC2 (Docker Compose + Caddy HTTPS).
# Cheap on purpose: no NAT, no ALB, no Elastic IP. Images come from ECR, secrets from
# SSM Parameter Store, deploys go through SSM Run Command (no SSH, port 22 closed).
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # Remote state in the bucket the bootstrap stack created. use_lockfile = S3-native
  # locking (no DynamoDB table needed, Terraform >= 1.10).
  backend "s3" {
    bucket       = "shopflow-tfstate-649320110403"
    key          = "stage1/terraform.tfstate"
    region       = "ap-southeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "shopflow", Stage = "stage1", ManagedBy = "terraform" } }
}

variable "region" {
  type    = string
  default = "ap-southeast-2" # the only Region our AWS project allows (ADR 0005)
}

variable "instance_type" {
  type = string
  # Free-tier eligible on the new Free plan, 2 vCPU / 8 GiB. The whole stack
  # (7 services + Postgres + Mongo + Redis + Kafka + observability) needs ~5 GiB.
  default = "m7i-flex.large"
}

variable "root_volume_gb" {
  type    = number
  default = 30 # free tier covers 30 GiB of gp3
}

data "aws_caller_identity" "me" {}

locals {
  name          = "shopflow-stage1"
  account_id    = data.aws_caller_identity.me.account_id
  ssm_prefix    = "/shopflow/prod"
  deploy_bucket = "shopflow-deploy-${data.aws_caller_identity.me.account_id}"
}
