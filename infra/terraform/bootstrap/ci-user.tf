# CI identity for GitHub Actions.
#
# Plan A was GitHub OIDC (no stored keys). Our AWS account is on the new "projects"
# experience: an AWS-managed SCP denies iam:*Provider*, so an OIDC provider cannot be created.
# See docs/adr/0005-ci-user-instead-of-oidc.md.
#
# Plan B (this file): a dedicated IAM user that can ONLY push to our ECR repos.
# - No console password (programmatic only).
# - The access key is created by hand with the CLI, NOT in Terraform
#   (Terraform state is plain text, so a key here would leak into terraform.tfstate).
# - The key lives only in GitHub Actions secrets. Rotate it every 90 days.
resource "aws_iam_user" "ci" {
  name = "shopflow-ci"
  path = "/ci/"
}

# LEAST PRIVILEGE: push to OUR repos only. Later stacks add deploy permissions.
data "aws_iam_policy_document" "ecr_push" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action cannot be scoped to a repository
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [for r in aws_ecr_repository.app : r.arn]
  }
}

resource "aws_iam_user_policy" "ci_ecr" {
  name   = "ecr-push"
  user   = aws_iam_user.ci.name
  policy = data.aws_iam_policy_document.ecr_push.json
}
