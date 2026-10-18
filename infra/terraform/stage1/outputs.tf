output "instance_id" { value = aws_instance.box.id }
output "public_ip" { value = aws_instance.box.public_ip }
output "web_tag_param" { value = aws_ssm_parameter.web_image_tag.name }
output "deploy_bucket" { value = aws_s3_bucket.deploy.bucket }
output "ssm_shell" { value = "aws ssm start-session --target ${aws_instance.box.id} --region ${var.region} --profile shopflow" }
