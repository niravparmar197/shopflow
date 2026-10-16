# ---------------- Blue-green for the payment service ----------------
# blue  = the normal "payment" ECS service (always there)
# green = "payment-green", only while a new version is being released
#
# scripts/blue-green.ps1:
#   deploy  -> new image on GREEN (idle: no user traffic, no background work)
#   preview -> smoke test GREEN in production through the gateway (secret header)
#   switch  -> LIVE = green: 100 % of users at once; blue kept for instant rollback
#   rollback-> LIVE = blue again
#   finish  -> blue gets the new image, LIVE = blue, green removed
#
# Only the LIVE colour runs background work (Kafka consumers, payment sweeper,
# jobs): the idle colour must not process events or expire payments.
variable "payment_blue_tag" {
  type    = string
  default = "" # "" = same as image_tag
}

variable "payment_green_tag" {
  type    = string
  default = "" # "" = no green deployment
}

variable "payment_live" {
  type    = string
  default = "blue"
  validation {
    condition     = contains(["blue", "green"], var.payment_live)
    error_message = "blue or green"
  }
}

locals {
  payment_blue_tag = coalesce(var.payment_blue_tag, var.image_tag)
  green_on         = var.payment_green_tag != ""
  live             = local.green_on ? var.payment_live : "blue"
  # Image tag per service: payment (blue) can differ from the rest during a release.
  tag_for = { for n in keys(local.services) : n => n == "payment" ? local.payment_blue_tag : var.image_tag }

  background_flags = ["KAFKA_CONSUMERS_ENABLED", "PAYMENT_SWEEPER_ENABLED", "JOBS_ENABLED"]
  green_background = local.live == "green" ? "true" : "false"

  # Green = blue's containers with the green image, its own background flags and log streams.
  green_containers = [
    for c in local.containers["payment"] : merge(c, {
      image = replace(c.image, ":${local.payment_blue_tag}", ":${var.payment_green_tag}")
      environment = [
        for e in c.environment :
        contains(local.background_flags, e.name) ? { name = e.name, value = local.green_background } : e
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options   = merge(local.log_options, { "awslogs-stream-prefix" = "payment-green" })
      }
    })
  ]
}

resource "aws_service_discovery_service" "payment_green" {
  count = local.green_on ? 1 : 0
  name  = "payment-green"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config { failure_threshold = 1 }
  force_destroy = true
}

resource "aws_ecs_task_definition" "payment_green" {
  count                    = local.green_on ? 1 : 0
  family                   = "${local.name}-payment-green"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode(local.green_containers)
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
}

resource "aws_ecs_service" "payment_green" {
  count           = local.green_on ? 1 : 0
  name            = "payment-green"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.payment_green[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.payment_green[0].arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

output "image_tag" { value = var.image_tag }
output "payment_blue_tag" { value = local.payment_blue_tag }
output "payment_green_tag" { value = var.payment_green_tag }
output "payment_live" { value = local.live }
