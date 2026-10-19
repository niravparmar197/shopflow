# ---------- Amazon SES: real emails (Phase 2 P4) ----------
# Off until you set ses_sender_email. Then:
#   1. terraform apply -> AWS emails that address a verification link: click it.
#   2. the next deploy sees MAIL_FROM in SSM and switches the notification
#      service from Mailpit to SES (deploy.sh writes EMAIL_PROVIDER=ses).
# A new SES account is in the SANDBOX: it only sends TO verified addresses
# (verify your test inboxes the same way) and at most 200 emails a day.
# Leaving the sandbox = a support request in the SES console.

variable "ses_sender_email" {
  type        = string
  default     = ""
  description = "The From address for real emails (verified in SES). Empty = keep Mailpit."
}

locals {
  ses_on = var.ses_sender_email != ""
}

resource "aws_sesv2_email_identity" "sender" {
  count          = local.ses_on ? 1 : 0
  email_identity = var.ses_sender_email
}

# The box may send, but only FROM this one address.
data "aws_iam_policy_document" "ses_send" {
  count = local.ses_on ? 1 : 0
  statement {
    sid     = "SendAsShopFlow"
    actions = ["ses:SendEmail"]
    # identity/* also covers the recipients' identities, which SES checks
    # while the account is in the sandbox.
    resources = ["arn:aws:ses:${var.region}:${local.account_id}:identity/*"]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_sender_email]
    }
  }
}

resource "aws_iam_role_policy" "ses_send" {
  count  = local.ses_on ? 1 : 0
  name   = "shopflow-ses-send"
  role   = aws_iam_role.box.id
  policy = data.aws_iam_policy_document.ses_send[0].json
}

# deploy.sh reads this: present = use SES.
resource "aws_ssm_parameter" "mail_from" {
  count       = local.ses_on ? 1 : 0
  name        = "${local.ssm_prefix}/MAIL_FROM"
  description = "From address for SES emails (its presence turns SES on)"
  type        = "String"
  value       = "ShopFlow <${var.ses_sender_email}>"
}

output "ses_sender_status" {
  value = local.ses_on ? "Check ${var.ses_sender_email} for the AWS verification email and click the link." : "SES off (Mailpit). Set ses_sender_email to turn it on."
}
