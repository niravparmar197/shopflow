# Stage 1 deploy: one EC2 box (free tier)

```
GitHub (merge to main)
  └─ release-images: build 7 images → Trivy → push to ECR (tag = git SHA)
       └─ deploy-stage1: bundle → S3 → SSM Run Command → deploy.sh on the box
                                                          ├─ secrets: SSM Parameter Store
                                                          ├─ images: ECR (instance role)
                                                          └─ docker compose up, health check, rollback

Internet ──443──▶ Caddy (Let's Encrypt, DuckDNS name) ──▶ gateway ──▶ 6 services
                                                        Postgres, Mongo, Redis, Kafka, MinIO
                                                        Prometheus, Grafana, Jaeger, Mailpit
```

| Piece | Choice | Why |
|---|---|---|
| Server | 1 × `m7i-flex.large` (2 vCPU, 8 GiB), Amazon Linux 2023 | Free-tier eligible; the full stack needs ~5 GiB |
| Region | `ap-southeast-2` (Sydney) | The only Region our AWS project allows (ADR 0005) |
| Access | SSM Session Manager + Run Command | No SSH, port 22 closed, no keys to lose |
| Public IP | Auto-assigned, **no Elastic IP** | Free; the box re-registers with DuckDNS on boot |
| HTTPS | Caddy, automatic Let's Encrypt | Certificates and renewals with zero config |
| Secrets | SSM Parameter Store SecureString | Free; never in git, images or Terraform state |
| State | S3 backend with native lock (`use_lockfile`) | No DynamoDB table needed |

## Public URLs

| URL | What | Login |
|---|---|---|
| `https://<sub>.duckdns.org/v1/...` | The API | JWT (signup/login) |
| `/docs` | Swagger UI (all services) | `admin` / SSM `ADMIN_PASSWORD` |
| `/grafana` | Dashboards | `admin` / SSM `GRAFANA_ADMIN_PASSWORD` |
| `/jaeger` | Traces | `admin` / SSM `ADMIN_PASSWORD` |
| `/mail` | Demo inbox (order emails) | `admin` / SSM `ADMIN_PASSWORD` |
| `/metrics`, `/internal/*` | Blocked at Caddy (404) | - |

## Demo-only choices (be ready to explain)

- **Payment runs the fake provider** with `NODE_ENV=development` (only that service), because the
  fake provider is refused in production on purpose. Real keys: `NODE_ENV=production`,
  `PAYMENT_PROVIDER=stripe`, keys in SSM.
- **Product images stay on the box** (MinIO, served at `/assets/...`). Presigned *upload* URLs point
  at `minio:9000`, so browser uploads only work in Stage 2 (real S3).
- **Single box = single point of failure.** Data lives in Docker volumes on the root EBS volume.
  `terraform destroy` deletes it. Stage 2 moves data to RDS / ElastiCache.
- **Mongo indexes are built on startup** (`MONGO_AUTO_INDEX=true`): tiny collections, and the unique
  indexes are part of the event dedupe.

## Day-2 commands (PowerShell, profile `shopflow`)

```powershell
# Shell on the box (no SSH)
aws ssm start-session --target <instance-id> --region ap-southeast-2 --profile shopflow
#   sudo -i; cd /opt/shopflow; cat current
#   docker compose -p shopflow ps
#   docker compose -p shopflow logs -f --tail 50 order

# Redeploy / roll back to any tag already in ECR
gh workflow run deploy-stage1 -f tag=<git-sha>

# Stop paying for compute (data stays; the IP changes, DuckDNS follows)
aws ec2 stop-instances  --instance-ids <id> --region ap-southeast-2 --profile shopflow
aws ec2 start-instances --instance-ids <id> --region ap-southeast-2 --profile shopflow
```
