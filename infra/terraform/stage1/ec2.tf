# Latest Amazon Linux 2023 (x86_64) from AWS's public SSM parameter.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# Accepted: Stage 1 has no load balancer, so the box itself needs a public IP.
#trivy:ignore:AWS-0009
resource "aws_instance" "box" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.box.name
  # Public IP without an Elastic IP. It CHANGES on stop/start; the box re-registers
  # itself with DuckDNS on every boot (user_data + timer), so the domain follows.
  associate_public_ip_address = true

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2          # containers may need instance credentials
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  user_data                   = file("${path.module}/user-data.sh")
  user_data_replace_on_change = false # editing the script must not destroy the box (and its data)

  lifecycle {
    ignore_changes = [ami] # a newer AMI must not replace the running box
  }

  tags = { Name = local.name }
}
