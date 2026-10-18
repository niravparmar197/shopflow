# DEV ONLY: give every product stock, so orders can be placed and paid.
# `npm run seed:product` fills only the catalog (Mongo); stock lives in the
# inventory service, and "no stock row" means 0 available → OUT_OF_STOCK.
#
#   .\scripts\seed-stock.ps1 -Email admin@example.com -Password Secret123 [-Qty 100] [-Api http://localhost:3000]
#
# The user must be an admin. Make one (then log in again):
#   docker exec -it shopflow-postgres psql -U shop -d users_db -c "UPDATE users SET role='admin' WHERE email='admin@example.com';"
param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [int]$Qty = 100,
  [string]$Api = "http://localhost:3000"
)
$ErrorActionPreference = "Stop"

$login = Invoke-RestMethod -Method Post "$Api/v1/auth/login" -ContentType "application/json" `
  -Body (@{ email = $Email; password = $Password } | ConvertTo-Json)
if ($login.user.role -ne "admin") { throw "$Email is not an admin (see the comment at the top)" }
$headers = @{ Authorization = "Bearer $($login.accessToken)" }
$body = @{ available = $Qty } | ConvertTo-Json

$count = 0
$cursor = $null
do {
  $url = "$Api/v1/products?limit=50"
  if ($cursor) { $url += "&cursor=$cursor" }
  $page = Invoke-RestMethod $url
  foreach ($p in $page.items) {
    Invoke-RestMethod -Method Put "$Api/v1/inventory/stock/$($p.id)" -Headers $headers `
      -ContentType "application/json" -Body $body | Out-Null
    $count++
    Write-Host "stock $Qty -> $($p.name)"
  }
  $cursor = $page.nextCursor
} while ($cursor)

Write-Host "Done: $count products now have $Qty in stock."
