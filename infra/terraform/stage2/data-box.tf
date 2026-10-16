# One EC2 for the stateful pieces we cannot buy on the Free plan:
# Kafka (MSK = paid plan), Mongo (DocumentDB = paid plan), plus Jaeger and Mailpit.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "data_box" {
  name               = "${local.name}-data-box"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

resource "aws_iam_role_policy_attachment" "data_box_ssm" {
  role       = aws_iam_role.data_box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "data_box" {
  name = "${local.name}-data-box"
  role = aws_iam_role.data_box.name
}

# Accepted: needs a public IP to pull images (no NAT); its SG only admits ECS tasks.
#trivy:ignore:AWS-0009
resource "aws_instance" "data" {
  ami                         = data.aws_ssm_parameter.al2023.value
  instance_type               = var.data_instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.data.id]
  iam_instance_profile        = aws_iam_instance_profile.data_box.name
  associate_public_ip_address = true
  user_data = templatefile("${path.module}/data-box.sh", { data_host = local.data_host })

  metadata_options {
    http_tokens = "required"
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }
  lifecycle {
    ignore_changes = [ami]
  }
  tags = { Name = "${local.name}-data" }
}
