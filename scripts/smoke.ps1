# Post-deploy smoke test: the gateway is up and the main paths work end to end.
#   ./scripts/smoke.ps1                                  (local compose)
#   ./scripts/smoke.ps1 -Base https://api.example.com    (after a deploy)
param([string]$Base = "http://localhost:3000")
$ErrorActionPreference = 'Stop'

"1. gateway ready"
Invoke-RestMethod "$Base/health/ready" | Out-Null

"2. products list"
Invoke-RestMethod "$Base/v1/products?limit=1" | Out-Null

"3. signup + login"
$email = "smoke+$([guid]::NewGuid().ToString('N').Substring(0, 8))@test.com"
$creds = @{ email = $email; password = 'Passw0rd!x' }
Invoke-RestMethod -Method Post "$Base/v1/auth/signup" -ContentType 'application/json' `
  -Body (($creds + @{ name = 'Smoke Test' }) | ConvertTo-Json) | Out-Null
$login = Invoke-RestMethod -Method Post "$Base/v1/auth/login" -ContentType 'application/json' `
  -Body ($creds | ConvertTo-Json)
if (-not $login.accessToken) { throw 'login returned no accessToken' }

"4. my orders (authenticated, via the read model)"
Invoke-RestMethod "$Base/v1/orders" -Headers @{ Authorization = "Bearer $($login.accessToken)" } | Out-Null

"SMOKE OK"
