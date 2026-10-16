# ---------------- RDS PostgreSQL ----------------
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

# The master password is created and kept by RDS in Secrets Manager
# (manage_master_user_password): it is NEVER in Terraform state or in git.
# ECS injects it into the containers; each service then builds its DATABASE_URL.
# Accepted for a short-lived demo DB: no Multi-AZ, 1-day backups, no deletion protection,
# no Performance Insights, no IAM DB auth.
#trivy:ignore:AWS-0077
#trivy:ignore:AWS-0133
#trivy:ignore:AWS-0176
#trivy:ignore:AWS-0177
resource "aws_db_instance" "main" {
  identifier                  = local.name
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = "db.t4g.micro" # free tier
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  username                    = "shop"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = 1
  skip_final_snapshot         = true # demo: `down` throws the data away on purpose
  deletion_protection         = false
  apply_immediately           = true
  auto_minor_version_upgrade  = true
}

# ---------------- ElastiCache Redis ----------------
resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

# Private subnet + SG (tasks only). No TLS/AUTH here: the services take a plain
# redis:// URL today; adding rediss:// + AUTH is a listed follow-up.
#trivy:ignore:AWS-0045
#trivy:ignore:AWS-0050
#trivy:ignore:AWS-0051
resource "aws_elasticache_cluster" "main" {
  cluster_id           = local.name
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  port                 = 6379
  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.db.id]
}

locals {
  redis_url  = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:6379"
  db_host    = aws_db_instance.main.address
  db_secret  = aws_db_instance.main.master_user_secret[0].secret_arn
  data_host  = "data.${local.ns}"
}
