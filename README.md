# ShopFlow

An online shop backend built as **7 microservices**. It shows how a real e-commerce system works: accounts, a product catalog, cart, checkout, payment, stock, emails, invoices and an admin panel.

**Web app:** [shopflow-frontend](https://github.com/niravparmar197/shopflow-frontend) (React micro frontends).
**Live demo:** https://shopflow-nirav.duckdns.org (only while the AWS box is running).

## Why this project

- **Learn and show microservices properly:** each service owns its data, and the services talk through events (Kafka) and gRPC, not a shared database.
- **Handle the hard parts of a shop:** no double orders on a double click, no overselling in a flash sale, money refunded when an order is cancelled, nothing lost when a service crashes.
- **Production-style setup:** tests, CI/CD, Docker images, monitoring and deploys to AWS with Terraform.

## Features

| Area | What you can do |
|---|---|
| Account | Sign up, log in, forgot / reset password by email, confirm email, edit name and phone, change password |
| Catalog | Search, filter by category and price, sort by price or newest, product photos |
| Wishlist | Save products with the heart and see them on one page |
| Reviews | Rate and review a product (only after it was delivered to you) |
| Cart | Add, change quantity, remove, apply a coupon |
| Checkout | Pick a saved delivery address, place the order (safe against double clicks) |
| Payment | Pay with the fake payment provider (demo); a failed or late payment cancels the order |
| Orders | My orders, live tracking (placed → paid → shipped → delivered), cancel before shipping (automatic refund), GST invoice PDF |
| Flash deals | Limited stock for a short time, a limit per customer, no overselling |
| Emails | Order confirmed, shipped, delivered, cancelled, refund, password reset, confirm email |
| Admin | Products and photos, stock, flash sales, coupons, all orders, ship / deliver / cancel |

## Services

| Service | Port | What it does |
|---|---|---|
| gateway | 3000 | The one public entry point: login check, rate limits, routing |
| user | 3001 | Accounts, login, addresses, wishlist |
| product | 3002 | Catalog, categories, reviews |
| order | 3003 | Cart, coupons, orders, invoices |
| payment | 3004 | Payments and refunds |
| inventory | 3005 | Stock and flash sales |
| notification | 3006 | Emails |

## Technologies

- **Backend:** Node.js 22, TypeScript, NestJS
- **Databases:** PostgreSQL (one database per service), MongoDB, Redis
- **Messaging:** Kafka (events with a transactional outbox), BullMQ (email queue)
- **Service calls:** gRPC, REST
- **Auth:** JWT (RS256) with refresh-token rotation
- **Monitoring:** OpenTelemetry, Jaeger, Prometheus, Grafana, Alertmanager
- **Testing:** Jest, Testcontainers, k6 (load test)
- **DevOps:** Docker, GitHub Actions, Trivy
- **AWS:** EC2, ECS Fargate, RDS, ElastiCache, S3, CloudFront, SES, SSM, Terraform
- **Other:** pdfkit (invoices), Mailpit (local email inbox), MinIO (local S3)

## Run on your computer

**Needs:** Node.js 22.12+, Docker Desktop, and the [web app repo](https://github.com/niravparmar197/shopflow-frontend) cloned next to this one (in `F:\projects`).

### First time only

```powershell
cd F:\projects\shopflow
npm install

# 1. Start the databases, Kafka and the other tools
docker compose -f infra/docker-compose.yml up -d

# 2. Config files and login keys
foreach ($a in 'gateway','user','product','order','inventory','payment','notification') {
  Copy-Item "apps/$a/.env.example" "apps/$a/.env"
}
node scripts/generate-jwt-keys.js
```

Then edit the `.env` files:
- `DATABASE_URL`: replace `USER:PASSWORD` with `shop:shop` (user, order, inventory, payment).
- `apps/payment/.env`: set `FAKE_WEBHOOK_SECRET` to any long random text.
- `apps/order/.env` and `apps/product/.env`: set the same `INTERNAL_API_TOKEN` (any long random text).

```powershell
# 3. Database tables, Kafka topics, sample products
npm run migration:run:user; npm run migration:run:order; npm run migration:run:payment; npm run migration:run:inventory
npm run kafka:topics
npm run seed:product
```

**4. Make yourself admin and add stock:**
1. Start everything (below), then sign up at http://localhost:5000.
2. Make your account admin, then log out and log in again:
   ```powershell
   docker exec -it shopflow-postgres psql -U shop -d users_db -c "UPDATE users SET role='admin' WHERE email='you@example.com';"
   ```
3. Give every product stock:
   ```powershell
   .\scripts\seed-stock.ps1 -Email you@example.com -Password YourPassword1
   ```

### Every day

```powershell
cd F:\projects\shopflow
.\scripts\start-all.ps1 -Web ..\shopflow-frontend   # leave out -Web for the backend only
```

This opens one window per service. Wait **2–3 minutes** for the first build, then open:

| What | Link |
|---|---|
| Shop | http://localhost:5000 |
| API docs (Swagger) | http://localhost:3000/docs |
| Emails (Mailpit) | http://localhost:8025 |
| Kafka UI | http://localhost:8081 |
| Traces (Jaeger) | http://localhost:16686 |
| Dashboards (Grafana) | http://localhost:3010 |

Stop everything (data is kept):

```powershell
.\scripts\stop-all.ps1
```

After pulling new code, run `npm install` and the `migration:run:*` commands again.

## How to use

1. **Shop:** browse, sort, filter, tap a heart to save, add to cart.
2. **Checkout:** add a delivery address, place the order, then pay (demo: press **Pay**).
3. **Track:** open **Orders**. You can cancel before it ships, and download the **Invoice (PDF)** once paid.
4. **Admin** (top bar, admins only): open **Orders**, click **Mark as shipped**, then **Mark as delivered**.
5. **Review:** after delivery, open the product and click **Write a review**.
6. **Flash sale:** in **Admin → Products**, start a flash sale on a product; it shows on **Deals**.
7. **Emails:** every email shows in Mailpit at http://localhost:8025.

## Deploy to AWS

Merging to `main` builds the images and deploys them automatically to the Stage 1 box (one EC2 server with Docker Compose and HTTPS). The box must be running.

```powershell
.\scripts\demo.ps1 stage1 start   # start the box (~2 min)
.\scripts\demo.ps1 status         # is it running?
.\scripts\demo.ps1 stage1 stop    # stop it to save money (data is kept)
```

If a deploy failed because the box was stopped: `gh run list`, then `gh run rerun <id>`.

The first-time AWS setup is in [docs/deploy-stage1.md](docs/deploy-stage1.md). Optional real emails with Amazon SES: set `ses_sender_email` in `infra/terraform/stage1/terraform.tfvars` and run `terraform apply`.

## Useful commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests |
| `npm run test:e2e` | Integration tests (needs Docker) |
| `npm run lint` | Check the code style |
| `npx nest start <service> --watch` | Run one service |
| `.\scripts\seed-live.ps1 -Email <you> -Password <pw>` | Live demo: make yourself admin, add products and stock |

## License

UNLICENSED — private project.
