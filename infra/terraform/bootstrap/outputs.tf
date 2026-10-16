output "github_role_arn" { value = aws_iam_role.github_ci.arn }
output "ecr_registry" { value = "${data.aws_caller_identity.me.account_id}.dkr.ecr.${var.region}.amazonaws.com" }
output "tfstate_bucket" { value = aws_s3_bucket.tfstate.bucket }
