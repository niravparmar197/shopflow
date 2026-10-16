# ---------- The box's own role (instance profile) ----------
data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "box" {
  name               = "${local.name}-box"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

# SSM agent: Session Manager shell + Run Command (replaces SSH).
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Pull our images.
resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Read OUR secrets (SecureString with the AWS-managed aws/ssm key) and OUR deploy bundles.
data "aws_iam_policy_document" "box" {
  statement {
    sid       = "ReadShopflowSecrets"
    actions   = ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}/*", "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}"]
  }
  statement {
    sid       = "ReadDeployBundles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.deploy.arn}/stage1/*"]
  }
}

resource "aws_iam_role_policy" "box" {
  name   = "shopflow-box"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.box.json
}

resource "aws_iam_instance_profile" "box" {
  name = "${local.name}-box"
  role = aws_iam_role.box.name
}

# ---------- Extra rights for the CI user (created by the bootstrap stack) ----------
# Upload a deploy bundle, then ask SSM to run deploy.sh on THIS instance only.
data "aws_iam_policy_document" "ci_deploy" {
  statement {
    sid       = "UploadBundle"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.deploy.arn}/stage1/*"]
  }
  statement {
    sid     = "RunDeployOnThisBox"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.box.arn,
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }
  # Accepted: GetCommandInvocation / ListCommandInvocations cannot be scoped to a resource.
  #trivy:ignore:AWS-0057
  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"] # these actions do not support resource-level scoping
  }
}

resource "aws_iam_user_policy" "ci_deploy" {
  name   = "stage1-deploy"
  user   = "shopflow-ci"
  policy = data.aws_iam_policy_document.ci_deploy.json
}
