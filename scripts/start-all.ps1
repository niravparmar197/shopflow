# Starts the whole ShopFlow stack for local dev, each part in its own window:
#   1. infrastructure (Docker: Postgres, Mongo, Redis, Kafka, MinIO, Jaeger, ...)
#   2. the 7 services (nest --watch)
#   3. the web app (optional, from the shopflow-frontend folder)
#
#   .\scripts\start-all.ps1                               # backend only
#   .\scripts\start-all.ps1 -Web ..\shopflow-frontend     # backend + web app
#
# Stop everything: .\scripts\stop-all.ps1
param([string]$Web = "")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "1/3 Infrastructure (Docker)..." -ForegroundColor Cyan
docker compose -f "$root/infra/docker-compose.yml" up -d
if ($LASTEXITCODE) { throw "docker compose failed. Is Docker Desktop running?" }

Write-Host "2/3 Services (one window each)..." -ForegroundColor Cyan
foreach ($a in 'user', 'product', 'order', 'inventory', 'payment', 'notification', 'gateway') {
  Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-Command',
    "`$Host.UI.RawUI.WindowTitle = 'shopflow $a'; npx nest start $a --watch"
}

if ($Web) {
  $webPath = (Resolve-Path $Web).Path
  Write-Host "3/3 Web app..." -ForegroundColor Cyan
  Start-Process powershell -WorkingDirectory $webPath -ArgumentList '-NoExit', '-Command',
    "`$Host.UI.RawUI.WindowTitle = 'shopflow web'; npm run dev"
}

Write-Host ""
Write-Host "Started. Services need ~30-60 s to compile and connect." -ForegroundColor Green
Write-Host "  Gateway   http://localhost:3000   (API docs: http://localhost:3000/docs)"
if ($Web) { Write-Host "  Web app   http://localhost:5000" }
Write-Host "  Kafka UI  http://localhost:8081   Jaeger http://localhost:16686   Mailpit http://localhost:8025"
