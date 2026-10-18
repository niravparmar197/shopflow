# The web app (shopflow-frontend repo) ships on its own: its own image
# (shopflow/web:<frontend git sha>) and its own deploy. This parameter holds the
# web tag that is live on the box, so a BACKEND deploy (deploy.sh) keeps it.
#
# - Terraform creates it once with "none" (= no web release yet: deploy.sh skips web).
# - The frontend deploy workflow writes the new tag AFTER the box reports healthy.
#   ignore_changes: Terraform must never reset it back to "none".
# - A plain String, not a secret.
resource "aws_ssm_parameter" "web_image_tag" {
  name        = "${local.ssm_prefix}/WEB_IMAGE_TAG"
  description = "Live shopflow/web image tag on Stage 1 (written by the frontend deploy workflow)"
  type        = "String"
  value       = "none"

  lifecycle {
    ignore_changes = [value]
  }
}
