# Stops what start-all.ps1 started: the service / web app windows (and their
# node processes), then the Docker infrastructure. Data is kept (volumes stay).
#   .\scripts\stop-all.ps1
$root = Split-Path -Parent $PSScriptRoot

Write-Host "Stopping service and web app windows..." -ForegroundColor Cyan
Get-Process powershell, pwsh -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'shopflow *' } |
  ForEach-Object { taskkill /PID $_.Id /T /F | Out-Null }

Write-Host "Stopping infrastructure (Docker)..." -ForegroundColor Cyan
docker compose -f "$root/infra/docker-compose.yml" stop

Write-Host "Stopped. Start again with .\scripts\start-all.ps1" -ForegroundColor Green
