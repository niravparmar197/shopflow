# Demo data for the LIVE Stage 1 site, through the normal API (never straight into
# the database): makes your user an admin, adds ~20 sample products, gives them stock.
# Safe to run again: existing products (same slug) are skipped, stock is just reset.
#
#   1. Sign up on the live site first (https://<sub>.duckdns.org/signup).
#   2. .\scripts\seed-live.ps1 -Email you@example.com -Password YourPassword1 [-Qty 100]
#
# Needs the AWS CLI profile "shopflow" (step "admin" runs one SQL update on the box
# through SSM Run Command; no SSH). Pass -SkipAdmin if the user is already an admin.
param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [int]$Qty = 100,
  [switch]$SkipAdmin,
  [string]$Profile = "shopflow",
  [string]$Region = "ap-southeast-2"
)
$ErrorActionPreference = "Stop"
$env:AWS_PROFILE = $Profile
$aws = @("--region", $Region)
function Say($m, $c = "Cyan") { Write-Host "[seed] $m" -ForegroundColor $c }
# The gateway allows 100 requests/min per IP: stay well under it.
function Gap { Start-Sleep -Milliseconds 800 }

if ($Email -notmatch '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') { throw "not a plain email: $Email" }

$sub = aws ssm get-parameter --name /shopflow/prod/DUCKDNS_SUBDOMAIN --with-decryption @aws --query Parameter.Value --output text
$Api = "https://$sub.duckdns.org"
Say "site: $Api"

# ---------- 1. admin ----------
if (-not $SkipAdmin) {
  $id = aws ec2 describe-instances @aws --filters "Name=tag:Name,Values=shopflow-stage1" "Name=instance-state-name,Values=running" `
    --query "Reservations[0].Instances[0].InstanceId" --output text
  if (-not $id -or $id -eq "None") { throw "the Stage 1 box is not running (.\scripts\demo.ps1 stage1 start)" }
  $sql = "UPDATE users SET role='admin' WHERE email='$($Email.ToLower())' RETURNING email"
  $cmd = "docker exec `$(docker ps -qf label=com.docker.compose.service=postgres) psql -U shop -d users_db -tAc `"$sql`""
  $file = New-TemporaryFile
  @{ commands = @($cmd) } | ConvertTo-Json | Set-Content -Encoding ascii $file
  $cmdId = aws ssm send-command --instance-ids $id --document-name AWS-RunShellScript @aws `
    --comment "seed-live: make admin" --parameters "file://$($file.FullName)" --query Command.CommandId --output text
  Remove-Item $file
  $tries = 0
  do {
    Start-Sleep 3; $tries++
    $st = aws ssm get-command-invocation --command-id $cmdId --instance-id $id @aws --query Status --output text 2>$null
  } while (($st -in "Pending", "InProgress", "Delayed", $null, "") -and $tries -lt 40)
  $out = (aws ssm get-command-invocation --command-id $cmdId --instance-id $id @aws --query StandardOutputContent --output text).Trim()
  if ($st -ne "Success" -or -not $out) {
    throw "could not make $Email an admin (status $st). Did you sign up on $Api with this email?"
  }
  Say "admin: $out"
}

# ---------- 2. log in (after the role change, so the token says admin) ----------
$login = Invoke-RestMethod -Method Post "$Api/v1/auth/login" -ContentType "application/json" `
  -Body (@{ email = $Email; password = $Password } | ConvertTo-Json)
if ($login.user.role -ne "admin") { throw "$Email is not an admin yet (run without -SkipAdmin)" }
$headers = @{ Authorization = "Bearer $($login.accessToken)" }
Gap

# ---------- 3. products ----------
# name, slug, category, price in rupees, attributes
$products = @(
  @("Nova X5 5G (8GB, 128GB)", "nova-x5-5g", "phones", 18999, @{ ram = "8GB"; storage = "128GB" }),
  @("Nova X5 Pro 5G (12GB, 256GB)", "nova-x5-pro-5g", "phones", 27999, @{ ram = "12GB"; storage = "256GB" }),
  @("Pixelite A3 (6GB, 128GB)", "pixelite-a3", "phones", 12499, @{ ram = "6GB"; storage = "128GB" }),
  @("Zenfold Lite 5G", "zenfold-lite-5g", "phones", 44999, @{ ram = "12GB"; storage = "256GB" }),
  @("AirBook 14 (i5, 16GB, 512GB SSD)", "airbook-14-i5", "laptops", 58990, @{ cpu = "Core i5"; ram = "16GB" }),
  @("AirBook 16 Pro (i7, 32GB, 1TB SSD)", "airbook-16-pro-i7", "laptops", 104990, @{ cpu = "Core i7"; ram = "32GB" }),
  @("WorkMate 15 (Ryzen 5, 8GB)", "workmate-15-ryzen5", "laptops", 41990, @{ cpu = "Ryzen 5"; ram = "8GB" }),
  @("GameForge 15 (RTX 4060)", "gameforge-15-rtx4060", "laptops", 89990, @{ gpu = "RTX 4060"; ram = "16GB" }),
  @("Pulse Fit Smartwatch", "pulse-fit-smartwatch", "watches", 2999, @{ strap = "silicone" }),
  @("Pulse Fit Pro (AMOLED, GPS)", "pulse-fit-pro", "watches", 6499, @{ display = "AMOLED"; gps = "yes" }),
  @("Classic Steel Analog Watch", "classic-steel-analog", "watches", 3499, @{ strap = "steel" }),
  @("Trailrunner Running Shoes", "trailrunner-running-shoes", "shoes", 3999, @{ size = "UK 9" }),
  @("CityWalk Sneakers", "citywalk-sneakers", "shoes", 2499, @{ size = "UK 8" }),
  @("Leather Formal Oxfords", "leather-formal-oxfords", "shoes", 4599, @{ size = "UK 9"; material = "leather" }),
  @("Cloudstep Slip-ons", "cloudstep-slip-ons", "shoes", 1799, @{ size = "UK 10" }),
  @("Oxford Cotton Shirt (White)", "oxford-cotton-shirt-white", "shirts", 1299, @{ size = "M"; fabric = "cotton" }),
  @("Linen Casual Shirt (Blue)", "linen-casual-shirt-blue", "shirts", 1699, @{ size = "L"; fabric = "linen" }),
  @("Checked Flannel Shirt", "checked-flannel-shirt", "shirts", 1499, @{ size = "M"; fabric = "flannel" }),
  @("Slim Fit Denim Shirt", "slim-fit-denim-shirt", "shirts", 1899, @{ size = "M"; fabric = "denim" }),
  @("Everyday Polo T-Shirt", "everyday-polo-tshirt", "shirts", 799, @{ size = "L"; fabric = "cotton" })
)
$created = 0; $skipped = 0
foreach ($p in $products) {
  $body = @{
    name        = $p[0]; slug = $p[1]; category = $p[2]
    description = "Sample $($p[2]) item for the ShopFlow demo."
    pricePaise  = [int]$p[3] * 100; attributes = $p[4]
  } | ConvertTo-Json
  try {
    Invoke-RestMethod -Method Post "$Api/v1/products" -Headers $headers -ContentType "application/json" -Body $body | Out-Null
    $created++; Say "  + $($p[0])"
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) { $skipped++ } else { throw }
  }
  Gap
}
Say "products: $created created, $skipped already there"

# ---------- 4. stock for every product ----------
$stock = @{ available = $Qty } | ConvertTo-Json
$count = 0; $cursor = $null
do {
  $url = "$Api/v1/products?limit=50"
  if ($cursor) { $url += "&cursor=$cursor" }
  $page = Invoke-RestMethod $url
  Gap
  foreach ($item in $page.items) {
    Invoke-RestMethod -Method Put "$Api/v1/inventory/stock/$($item.id)" -Headers $headers -ContentType "application/json" -Body $stock | Out-Null
    $count++
    Gap
  }
  $cursor = $page.nextCursor
} while ($cursor)
Say "stock: $count products now have $Qty available" "Green"
Say "done. Open $Api and log in again (your account is now an admin)." "Green"
