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

# The new AWS "projects" experience has an AWS-managed SCP (RegionFloor):
# only the project's own Region is allowed. Our project Region is Sydney (ap-southeast-2).
# Mumbai and us-east-1 were both tested and denied.
variable "region" {
  type    = string
  default = "ap-southeast-2"
}

variable "alert_email" {
  type        = string
  description = "Where budget alerts are sent"
}

variable "apps" {
  type    = list(string)
  default = ["gateway", "user", "product", "order", "inventory", "payment", "notification", "web"] # web = the micro frontends (shopflow-frontend repo)
}

data "aws_caller_identity" "me" {}
