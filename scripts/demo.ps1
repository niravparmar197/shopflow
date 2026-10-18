# Start / stop ShopFlow on AWS for a demo, with one command.
#
#   .\scripts\demo.ps1 status
#   .\scripts\demo.ps1 stage1 start      # ~2 min. The always-ready box (Compose + Caddy, DuckDNS) + web app
#   .\scripts\demo.ps1 stage1 stop       # compute stops; data, certs, DNS stay
#
#   .\scripts\demo.ps1 stage2 up         # ~15-20 min. Creates everything (Terraform), newest images
#   .\scripts\demo.ps1 stage2 pause      # ~2 min. Tasks to 0, RDS + data box stopped (ALB/Redis keep billing)
#   .\scripts\demo.ps1 stage2 resume     # ~8 min. Back up, same data
#   .\scripts\demo.ps1 stage2 down       # ~10 min. Deletes EVERYTHING in Stage 2 (data too) -> ~$0
#
# Rough cost while running: Stage 1 ~ free tier hours; Stage 2 ~ $0.25-0.35 / hour.
param(
  [Parameter(Position = 0)] [ValidateSet("status", "stage1", "stage2")] [string]$Target = "status",
  [Parameter(Position = 1)] [string]$Action = "",
  [string]$Profile = "shopflow",
  [string]$Region = "ap-southeast-2",
  [string]$ImageTag = ""   # default: newest image in ECR
)
$ErrorActionPreference = "Stop"
$env:AWS_PROFILE = $Profile
$root = Split-Path -Parent $PSScriptRoot
$tf1 = Join-Path $root "infra\terraform\stage1"
$tf2 = Join-Path $root "infra\terraform\stage2"
$aws = @("--region", $Region)
$services = "gateway", "user", "product", "order", "inventory", "payment", "notification"

function Say($m) { Write-Host "[demo] $m" -ForegroundColor Cyan }
function TfOut($dir, $name) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $v = terraform "-chdir=$dir" output -raw $name 2>$null
  $ErrorActionPreference = $old
  if ($LASTEXITCODE -ne 0 -or -not $v -or $v -match "No outputs") { return $null }
  return $v
}
function WaitHealthy($url, [int]$minutes = 15) {
  Say "waiting for $url/health/ready (up to $minutes min)..."
  $deadline = (Get-Date).AddMinutes($minutes)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod "$url/health/ready" -TimeoutSec 10
      if ($r.status -eq "ok") { Say "LIVE: $url"; return }
    } catch { }
    Start-Sleep 15
  }
  Write-Host "Not healthy yet. Check the ECS console, CloudWatch Logs (/shopflow/stage2) or an SSM shell." -ForegroundColor Yellow
}
# The web app (shopflow-frontend) on the same box: answers once its container is up.
function WebCheck($url) {
  try {
    Invoke-WebRequest "$url/mfe-manifest.json" -UseBasicParsing -TimeoutSec 10 | Out-Null
    Say "web app OK: $url"
  } catch {
    Write-Host "Web app not answering ($url). No web release yet? See the frontend repo's deploy-stage1 workflow." -ForegroundColor Yellow
  }
}
function NewestTag {
  if ($ImageTag) { return $ImageTag }
  aws ecr describe-images --repository-name shopflow/gateway @aws `
    --query "sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]" --output text
}
function SsmValue($name) {
  aws ssm get-parameter --name "/shopflow/prod/$name" --with-decryption @aws --query Parameter.Value --output text
}

# ---------------- Stage 1 ----------------
# Instance id from Terraform; if that read fails (lock, network, no init), ask EC2 by tag.
function Stage1Id {
  $id = TfOut $tf1 "instance_id"
  if ($id) { return $id }
  $id = aws ec2 describe-instances @aws --filters "Name=tag:Name,Values=shopflow-stage1" `
    "Name=instance-state-name,Values=pending,running,stopping,stopped" `
    --query "Reservations[0].Instances[0].InstanceId" --output text
  if ($id -and $id -ne "None") { return $id }
  return $null
}

function Stage1($action) {
  $id = Stage1Id
  if (-not $id) { throw "Stage 1 is not created (infra/terraform/stage1)" }
  $domain = "https://$(SsmValue DUCKDNS_SUBDOMAIN).duckdns.org"
  switch ($action) {
    "start" {
      aws ec2 start-instances --instance-ids $id @aws | Out-Null
      aws ec2 wait instance-running --instance-ids $id @aws
      Say "box running (new public IP; DuckDNS follows within ~1 min, containers auto-start)"
      WaitHealthy $domain 8
      WebCheck $domain
    }
    "stop" {
      aws ec2 stop-instances --instance-ids $id @aws | Out-Null
      Say "stopping $id (data, certificates and DNS name are kept)"
    }
    default { throw "use: stage1 start | stop" }
  }
}

# ---------------- Stage 2 ----------------
function Stage2($action) {
  switch ($action) {
    "up" {
      $tag = NewestTag
      $email = SsmValue ACME_EMAIL
      Say "terraform apply (images: $tag) - about 15-20 min the first time"
      terraform "-chdir=$tf2" init -input=false | Out-Null
      terraform "-chdir=$tf2" apply -auto-approve -input=false -var "image_tag=$tag" -var "alert_email=$email"
      if ($LASTEXITCODE -ne 0) { throw "terraform apply failed" }
      WaitHealthy (TfOut $tf2 "url") 20
      Say "Jaeger:  $(TfOut $tf2 'jaeger_tunnel')"
      Say "Mailpit: $(TfOut $tf2 'mailpit_tunnel')"
    }
    "down" {
      Say "terraform destroy: deletes ALL Stage 2 resources and data"
      terraform "-chdir=$tf2" init -input=false | Out-Null
      terraform "-chdir=$tf2" destroy -auto-approve -input=false -var "image_tag=unused" -var "alert_email=unused@example.com"
    }
    "pause" {
      $cluster = TfOut $tf2 "cluster"; if (-not $cluster) { throw "Stage 2 is not up" }
      foreach ($s in $services) { aws ecs update-service --cluster $cluster --service $s --desired-count 0 @aws | Out-Null }
      Say "ECS services -> 0 tasks"
      aws rds stop-db-instance --db-instance-identifier shopflow-stage2 @aws | Out-Null
      Say "RDS stopping (AWS starts it again by itself after 7 days)"
      aws ec2 stop-instances --instance-ids (TfOut $tf2 "data_box_id") @aws | Out-Null
      Say "data box stopping. Still billing while paused: ALB (~`$0.03/h) and Redis (free tier)."
    }
    "resume" {
      $cluster = TfOut $tf2 "cluster"; if (-not $cluster) { throw "Stage 2 is not up: use 'stage2 up'" }
      aws ec2 start-instances --instance-ids (TfOut $tf2 "data_box_id") @aws | Out-Null
      $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
      aws rds start-db-instance --db-instance-identifier shopflow-stage2 @aws 2>$null | Out-Null
      $ErrorActionPreference = $old
      Say "waiting for RDS (about 5 min)..."
      aws rds wait db-instance-available --db-instance-identifier shopflow-stage2 @aws
      foreach ($s in $services) { aws ecs update-service --cluster $cluster --service $s --desired-count 1 @aws | Out-Null }
      Say "ECS services -> 1 task each"
      WaitHealthy (TfOut $tf2 "url") 10
    }
    default { throw "use: stage2 up | pause | resume | down" }
  }
}

function Status {
  $id = Stage1Id
  if ($id) {
    $st = aws ec2 describe-instances --instance-ids $id @aws --query "Reservations[0].Instances[0].State.Name" --output text
    Say "Stage 1: $st  https://$(SsmValue DUCKDNS_SUBDOMAIN).duckdns.org"
    $web = SsmValue WEB_IMAGE_TAG
    if ($web -and $web -ne "none") { $web = $web.Substring(0, [Math]::Min(7, $web.Length)) }
    Say "         web app version (frontend commit): $web"
  } else { Say "Stage 1: not created" }
  $cluster = TfOut $tf2 "cluster"
  if ($cluster) {
    $running = aws ecs describe-services --cluster $cluster --services $services @aws --query "sum(services[].runningCount)" --output text
    Say "Stage 2: UP, $running/7 tasks running  $(TfOut $tf2 'url')"
  } else { Say "Stage 2: down (costs nothing)" }
}

switch ($Target) {
  "status" { Status }
  "stage1" { Stage1 $Action }
  "stage2" { Stage2 $Action }
}
