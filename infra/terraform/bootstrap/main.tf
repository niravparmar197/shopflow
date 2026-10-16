# Bootstrap stack: things every later stack needs.
# Uses LOCAL state on purpose: it creates the S3 bucket that later stacks use for remote state.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "shopflow", ManagedBy = "terraform" } } # every resource tagged → easy cost view
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "alert_email" {
  type        = string
  description = "Where budget alerts are sent"
}

variable "github_repo" {
  type        = string
  description = "owner/repo allowed to assume the CI role"
  default     = "niravparmar197/shopflow"
}

variable "apps" {
  type    = list(string)
  default = ["gateway", "user", "product", "order", "inventory", "payment", "notification"]
}

data "aws_caller_identity" "me" {}
