# Stage 1 deploy: one EC2 box (free tier)

```
GitHub (merge to main)
  └─ release-images: build 7 images → Trivy → push to ECR (tag = git SHA)
       └─ deploy-stage1: bundle → S3 → SSM Run Command → deploy.sh on the box
                                                          ├─ secrets: SSM Parameter Store
                                                          ├─ images: ECR (instance role)
                                                          └─ docker compose up, health check, rollback

shopflow-frontend (merge to main)
  └─ release-image: build web image → Trivy → ECR shopflow/web:<sha>
       └─ deploy-stage1: SSM WEB_IMAGE_TAG → SSM Run Command → deploy-web.sh (web only)

Internet ──443──▶ Caddy (Let's Encrypt, DuckDNS name) ──▶ /v1, /health, /docs: gateway ──▶ 6 services
                                                     └─▶ everything else: web (nginx, the shop UI)
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
| `https://<sub>.duckdns.org/` | The web shop | Sign up in the app |
| `/v1/...` | The API | JWT (signup/login) |
| `/docs` | Swagger UI (all services) | `admin` / SSM `ADMIN_PASSWORD` |
| `/grafana` | Dashboards | `admin` / SSM `GRAFANA_ADMIN_PASSWORD` |
| `/jaeger` | Traces | `admin` / SSM `ADMIN_PASSWORD` |
| `/mail` | Demo inbox (order emails) | `admin` / SSM `ADMIN_PASSWORD` |
| `/metrics`, `/internal/*` | Blocked at Caddy (404) | - |

## Web app (ADR 0007)

The shop UI ships from the [shopflow-frontend](https://github.com/niravparmar197/shopflow-frontend)
repo as its own image, `shopflow/web:<frontend sha>`, on the same origin as the API.

| Piece | Where |
|---|---|
| ECR repo `shopflow/web` | `infra/terraform/bootstrap` (`var.apps`) |
| Live web tag `/shopflow/prod/WEB_IMAGE_TAG` + CI right to write it | `infra/terraform/stage1/web.tf`, `iam.tf` |
| `web` service (profile `web`), Caddy routes | `deploy/stage1/docker-compose.yml`, `Caddyfile` |
| Deploy only the web container, with rollback | `deploy/stage1/deploy-web.sh` |

**First time (once):**
1. `terraform apply` in `infra/terraform/bootstrap` (adds the ECR repo), then in
   `infra/terraform/stage1` (adds the SSM parameter and the CI right). Neither touches the box.
2. Merge the backend change: Caddy + compose with the `web` service. The tag is still `none`,
   so `web` is skipped; the API works as before (`/` answers 502 until step 4).
3. In the frontend repo, add the same GitHub secrets (`AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`) and variables (`AWS_REGION`, `ECR_REGISTRY`, `STAGE1_INSTANCE_ID`,
   `STAGE1_DOMAIN`) as here, and an environment `stage1`.
4. Merge to the frontend `main`: `release-image` → `deploy-stage1` puts the shop live.

**Demo data (empty site after the first deploy):** sign up on the site, then
`.\scripts\seed-live.ps1 -Email you@example.com -Password YourPassword1`. It makes that user an
admin (one SQL update through SSM Run Command), adds ~20 sample products through the API and
gives them stock. Safe to re-run.

**Roll back the web app:** frontend repo → Actions → `deploy-stage1` → Run workflow with an older tag
(`gh workflow run deploy-stage1 -R niravparmar197/shopflow-frontend -f tag=<sha>`).

## Demo-only choices (be ready to explain)

- **Payment runs the fake provider** with `NODE_ENV=development` (only that service), because the
  fake provider is refused in production on purpose. Real keys: `NODE_ENV=production`,
  `PAYMENT_PROVIDER=stripe`, keys in SSM.
- **Product images stay on the box** (MinIO, served at `/assets/products/...`). Presigned *upload* URLs point
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
gh workflow run deploy-stage1 -f tag=<git-sha>                                            # backend
gh workflow run deploy-stage1 -R niravparmar197/shopflow-frontend -f tag=<frontend-sha>    # web app
# Which versions are live?   cat /opt/shopflow/current   ·   grep WEB_IMAGE_TAG /opt/shopflow/shared/.env

# Stop paying for compute (data stays; the IP changes, DuckDNS follows)
aws ec2 stop-instances  --instance-ids <id> --region ap-southeast-2 --profile shopflow
aws ec2 start-instances --instance-ids <id> --region ap-southeast-2 --profile shopflow
```
