# ---------------- cluster, logs, service discovery ----------------
# Accepted: Container Insights off (extra CloudWatch cost on a credit budget).
#trivy:ignore:AWS-0034
resource "aws_ecs_cluster" "main" {
  name = local.name
}

# Accepted: AWS-managed encryption for short-lived demo logs.
#trivy:ignore:AWS-0017
resource "aws_cloudwatch_log_group" "apps" {
  name              = "/shopflow/stage2"
  retention_in_days = 3
}

# <service>.shopflow.local -> the task's private IP (A records, TTL 10 s).
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = local.ns
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "svc" {
  for_each = toset(keys(local.services))
  name     = each.key
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

# The data box is not an ECS task: register its private IP by hand. No custom
# health check here (nobody would report it healthy), so the record is always served.
resource "aws_service_discovery_service" "data" {
  name = "data"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  force_destroy = true
}

resource "aws_service_discovery_instance" "data" {
  instance_id = "data-box"
  service_id  = aws_service_discovery_service.data.id
  attributes  = { AWS_INSTANCE_IPV4 = aws_instance.data.private_ip }
}

# ---------------- IAM ----------------
data "aws_iam_policy_document" "ecs_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role = what ECS itself needs to START a task: pull from ECR, write
# logs, read the secrets it injects (SSM params + the RDS-managed secret).
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_trust.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}/*"]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.db_secret]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "inject-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task role = what the APP may do at runtime. Only product needs AWS (S3 images).
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_trust.json
}

resource "aws_iam_role" "product_task" {
  name               = "${local.name}-product-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_trust.json
}

data "aws_iam_policy_document" "product_s3" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.products.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.products.arn]
  }
}

resource "aws_iam_role_policy" "product_s3" {
  name   = "product-images"
  role   = aws_iam_role.product_task.id
  policy = data.aws_iam_policy_document.product_s3.json
}

# ---------------- the 7 services ----------------
locals {
  ssm = "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}"

  common_env = {
    NODE_ENV                    = "production"
    PORT                        = "3000"
    LOG_LEVEL                   = "info"
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://${local.data_host}:4318"
  }
  # Postgres services: container-env.js builds DATABASE_URL from these + DB_PASSWORD.
  db_env = {
    DB_HOST         = local.db_host
    DB_USER         = "shop"
    DATABASE_SSL_CA = "/app/certs/rds-global-bundle.pem" # verified TLS to RDS
  }

  services = {
    gateway = {
      db = null
      env = {
        REDIS_URL                = local.redis_url
        USER_SERVICE_URL         = "http://user.${local.ns}:3000"
        PRODUCT_SERVICE_URL      = "http://product.${local.ns}:3000"
        ORDER_SERVICE_URL        = "http://order.${local.ns}:3000"
        INVENTORY_SERVICE_URL    = "http://inventory.${local.ns}:3000"
        PAYMENT_SERVICE_URL      = "http://payment.${local.ns}:3000"
        NOTIFICATION_SERVICE_URL = "http://notification.${local.ns}:3000"
        PRODUCT_GRPC_URL         = "product.${local.ns}:50052"
        CORS_ORIGINS             = local.public_url
        TRUST_PROXY_HOPS         = "2" # CloudFront + ALB
        RATE_LIMIT_GLOBAL_PER_MIN = "100"
        # Blue-green (blue-green.tf): blue = PAYMENT_SERVICE_URL, green below.
        PAYMENT_GREEN_URL  = local.green_on ? "http://payment-green.${local.ns}:3000" : ""
        PAYMENT_LIVE_COLOR = local.live
      }
      secrets = {
        JWT_PUBLIC_KEY = "${local.ssm}/JWT_PUBLIC_KEY"
        PREVIEW_TOKEN  = "${local.ssm}/ADMIN_PASSWORD" # lets a tester reach the idle colour
      }
    }
    user = {
      db = "users_db"
      env = {
        REDIS_URL         = local.redis_url
        ACCESS_TOKEN_TTL  = "15m"
        REFRESH_TOKEN_DAYS = "7"
      }
      secrets = {
        JWT_PRIVATE_KEY = "${local.ssm}/JWT_PRIVATE_KEY"
        JWT_PUBLIC_KEY  = "${local.ssm}/JWT_PUBLIC_KEY"
      }
    }
    product = {
      db = null
      env = {
        GRPC_PORT        = "50052"
        MONGO_URL        = "mongodb://${local.data_host}:27017/products_db"
        MONGO_AUTO_INDEX = "true"
        REDIS_URL        = local.redis_url
        S3_BUCKET        = aws_s3_bucket.products.bucket
        S3_REGION        = var.region
        ASSET_BASE_URL   = local.public_url # keys are products/<id>/..., served by CloudFront
      }
      secrets = { JWT_PUBLIC_KEY = "${local.ssm}/JWT_PUBLIC_KEY" }
    }
    order = {
      db = "orders_db"
      env = {
        REDIS_URL             = local.redis_url
        KAFKA_BROKERS         = "${local.data_host}:9092"
        PRODUCT_GRPC_URL      = "product.${local.ns}:50052"
        INVENTORY_SERVICE_URL = "http://inventory.${local.ns}:3000"
        FLASH_BULKHEAD_MAX    = "50"
        FLASH_BULKHEAD_QUEUE  = "200"
      }
      secrets = {
        JWT_PUBLIC_KEY     = "${local.ssm}/JWT_PUBLIC_KEY"
        INTERNAL_API_TOKEN = "${local.ssm}/INTERNAL_API_TOKEN"
      }
    }
    inventory = {
      db = "inventory_db"
      env = {
        REDIS_URL     = local.redis_url
        KAFKA_BROKERS = "${local.data_host}:9092"
      }
      secrets = {
        JWT_PUBLIC_KEY     = "${local.ssm}/JWT_PUBLIC_KEY"
        INTERNAL_API_TOKEN = "${local.ssm}/INTERNAL_API_TOKEN"
      }
    }
    payment = {
      db = "payments_db"
      env = {
        # DEMO: fake provider (see docs/deploy-stage1.md); this one service stays "development".
        NODE_ENV                = "development"
        PAYMENT_PROVIDER        = "fake"
        KAFKA_BROKERS           = "${local.data_host}:9092"
        PAYMENT_TTL_MINUTES = "15"
        PAYMENT_SWEEP_MS    = "30000"
        # Background work only on the LIVE colour (blue-green.tf).
        KAFKA_CONSUMERS_ENABLED = local.live == "blue" ? "true" : "false"
        PAYMENT_SWEEPER_ENABLED = local.live == "blue" ? "true" : "false"
        JOBS_ENABLED            = local.live == "blue" ? "true" : "false"
      }
      secrets = {
        JWT_PUBLIC_KEY      = "${local.ssm}/JWT_PUBLIC_KEY"
        FAKE_WEBHOOK_SECRET = "${local.ssm}/FAKE_WEBHOOK_SECRET"
      }
    }
    notification = {
      db = null
      env = {
        MONGO_URL        = "mongodb://${local.data_host}:27017/notifications_db"
        MONGO_AUTO_INDEX = "true"
        REDIS_URL        = local.redis_url
        KAFKA_BROKERS    = "${local.data_host}:9092"
        SMTP_HOST        = local.data_host
        SMTP_PORT        = "1025"
        MAIL_FROM        = "ShopFlow <no-reply@shopflow.local>"
      }
      secrets = { JWT_PUBLIC_KEY = "${local.ssm}/JWT_PUBLIC_KEY" }
    }
  }

  log_options = {
    "awslogs-group"         = aws_cloudwatch_log_group.apps.name
    "awslogs-region"        = var.region
    "awslogs-stream-prefix" = "app"
  }

  health_check = {
    command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
    interval    = 15
    timeout     = 5
    retries     = 3
    startPeriod = 90
  }

  kafka_services = ["order", "inventory", "payment", "notification"]

  # Per service: [db-init] -> [kafka-topics] -> app. Init containers are not
  # essential; the app starts only after they exit 0 (dependsOn SUCCESS).
  containers = {
    for name, s in local.services : name => concat(
      s.db == null ? [] : [{
        name      = "db-init"
        image     = "public.ecr.aws/docker/library/postgres:16-alpine"
        essential = false
        # Create this service's database once (RDS only creates "postgres").
        command = ["sh", "-c", "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${s.db}'\" | grep -q 1 || psql -c 'CREATE DATABASE ${s.db}'"]
        environment = [
          { name = "PGHOST", value = local.db_host },
          { name = "PGUSER", value = "shop" },
          { name = "PGDATABASE", value = "postgres" },
          { name = "PGSSLMODE", value = "require" },
        ]
        secrets          = [{ name = "PGPASSWORD", valueFrom = "${local.db_secret}:password::" }]
        logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { "awslogs-stream-prefix" = "${name}-init" }) }
      }],
      !contains(local.kafka_services, name) ? [] : [{
        name             = "kafka-topics"
        image            = "${local.registry}/shopflow/${name}:${local.tag_for[name]}"
        essential        = false
        command          = ["node", "scripts/kafka-topics.js"]
        environment      = [{ name = "KAFKA_BROKERS", value = "${local.data_host}:9092" }]
        logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { "awslogs-stream-prefix" = "${name}-init" }) }
      }],
      [merge({
        name      = name
        image     = "${local.registry}/shopflow/${name}:${local.tag_for[name]}"
        essential = true
        portMappings = concat(
          [{ containerPort = 3000, protocol = "tcp" }],
          name == "product" ? [{ containerPort = 50052, protocol = "tcp" }] : []
        )
        environment = [
          for k, v in merge(
            local.common_env,
            { for k2, v2 in merge(local.db_env, { DB_NAME = s.db }) : k2 => v2 if s.db != null },
            s.env,
            { SERVICE_NAME = name },
          ) : { name = k, value = v }
        ]
        secrets = concat(
          [for k, v in s.secrets : { name = k, valueFrom = v }],
          s.db == null ? [] : [{ name = "DB_PASSWORD", valueFrom = "${local.db_secret}:password::" }]
        )
        dependsOn = concat(
          s.db == null ? [] : [{ containerName = "db-init", condition = "SUCCESS" }],
          contains(local.kafka_services, name) ? [{ containerName = "kafka-topics", condition = "SUCCESS" }] : []
        )
        healthCheck      = local.health_check
        logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { "awslogs-stream-prefix" = name }) }
        },
        # Postgres services: run migrations first (advisory-locked, idempotent), then serve.
        { for k, v in { command = ["sh", "-c", "node dist/main.js migrate && exec node --enable-source-maps dist/main.js"] } : k => v if s.db != null }
      )]
    )
  }
}

# Service configs have different env keys (an object, not a map): iterate names.
resource "aws_ecs_task_definition" "svc" {
  for_each                 = toset(keys(local.services))
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = each.key == "product" ? aws_iam_role.product_task.arn : aws_iam_role.task.arn
  container_definitions    = jsonencode(local.containers[each.key])
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
}

resource "aws_ecs_service" "svc" {
  for_each        = toset(keys(local.services))
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.svc[each.key].arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true # no NAT: pull images / reach AWS APIs; SG blocks all inbound from outside
  }

  service_registries {
    registry_arn = aws_service_discovery_service.svc[each.key].arn
  }

  dynamic "load_balancer" {
    for_each = each.key == "gateway" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.gateway.arn
      container_name   = "gateway"
      container_port   = 3000
    }
  }
  health_check_grace_period_seconds = each.key == "gateway" ? 120 : null

  # Rolling deploy that undoes itself: if new tasks keep failing, ECS rolls back.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  lifecycle {
    ignore_changes = [desired_count] # demo.ps1 pause/resume scales outside Terraform
  }
  depends_on = [aws_lb_listener_rule.from_cloudfront, aws_service_discovery_instance.data]
}
