output "url" { value = local.public_url }
output "alb_dns" { value = aws_lb.main.dns_name }
output "data_box_id" { value = aws_instance.data.id }
output "rds_endpoint" { value = aws_db_instance.main.address }
output "cluster" { value = aws_ecs_cluster.main.name }
output "jaeger_tunnel" {
  description = "Then open http://localhost:16686"
  value       = "aws ssm start-session --target ${aws_instance.data.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=16686,localPortNumber=16686 --region ${var.region} --profile shopflow"
}
output "mailpit_tunnel" {
  description = "Then open http://localhost:8025"
  value       = "aws ssm start-session --target ${aws_instance.data.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=8025,localPortNumber=8025 --region ${var.region} --profile shopflow"
}
