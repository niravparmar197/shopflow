# Upload the Stage 1 secrets to SSM Parameter Store (SecureString, free standard tier).
# Run ONCE before the first deploy. Safe to re-run: existing values are KEPT
# (changing POSTGRES_PASSWORD after the first start would lock the apps out).
#
#   .\scripts\put-stage1-secrets.ps1 -DuckDnsSubdomain shopflow-nirav -AcmeEmail you@gmail.com
#
# It asks for the DuckDNS token (hidden input). Random secrets are generated here,
# JWT keys go to keys-prod\ (git-ignored) and to SSM. Nothing secret is printed.
# -Force <Name> replaces one existing value, e.g. -Force ADMIN_PASSWORD.
param(
  [Parameter(Mandatory)] [string]$DuckDnsSubdomain,   # "shopflow-nirav" (without .duckdns.org)
  [Parameter(Mandatory)] [string]$AcmeEmail,          # Let's Encrypt expiry notices
  [string]$Profile = "shopflow",
  [string]$Region = "ap-southeast-2",
  [string[]]$Force = @()
)
$ErrorActionPreference = "Stop"
$prefix = "/shopflow/prod"

function Test-Param([string]$name) {
  # "ParameterNotFound" goes to stderr; with Stop, Windows PowerShell would throw on it.
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    aws ssm get-parameter --name "$prefix/$name" --profile $Profile --region $Region --query Parameter.Name --output text 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $old }
}

function Put-Param([string]$name, [string]$value, [string]$type = "SecureString") {
  if ((Test-Param $name) -and ($Force -notcontains $name)) {
    Write-Host "  = $name (exists, kept)"
    return
  }
  # Value via a temp file: no secret on the command line, and PEM newlines survive.
  $tmp = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($tmp.FullName, $value)
    aws ssm put-parameter --name "$prefix/$name" --type $type --value "file://$($tmp.FullName)" `
      --overwrite --profile $Profile --region $Region | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "put-parameter $name failed" }
    Write-Host "  + $name"
  } finally {
    Remove-Item $tmp.FullName -Force
  }
}

function New-Secret([int]$bytes = 24) {
  # Hex: safe inside URLs (postgresql://shop:<password>@...) and shell quotes.
  $buf = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return -join ($buf | ForEach-Object { $_.ToString("x2") })
}

Write-Host "Checking AWS access..."
aws sts get-caller-identity --profile $Profile --query Arn --output text
if ($LASTEXITCODE -ne 0) { throw "AWS CLI profile '$Profile' does not work" }

# ---- plain settings (not secret, but kept together) ----
Write-Host "Settings:"
Put-Param DUCKDNS_SUBDOMAIN $DuckDnsSubdomain "String"
Put-Param ACME_EMAIL $AcmeEmail "String"

# ---- DuckDNS token (asked, hidden) ----
if (-not (Test-Param DUCKDNS_TOKEN) -or ($Force -contains "DUCKDNS_TOKEN")) {
  $sec = Read-Host "DuckDNS token (from duckdns.org, input hidden)" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  if ([string]::IsNullOrWhiteSpace($plain)) { throw "empty DuckDNS token" }
  Put-Param DUCKDNS_TOKEN $plain.Trim()
} else { Write-Host "  = DUCKDNS_TOKEN (exists, kept)" }

# ---- generated secrets ----
Write-Host "Generated secrets:"
foreach ($n in "POSTGRES_PASSWORD", "INTERNAL_API_TOKEN", "FAKE_WEBHOOK_SECRET",
                "MINIO_ROOT_PASSWORD", "GRAFANA_ADMIN_PASSWORD", "ADMIN_PASSWORD") {
  Put-Param $n (New-Secret)
}

# ---- JWT key pair (production keys, NOT the local dev ones in keys\) ----
Write-Host "JWT keys:"
$keyDir = Join-Path (Get-Location) "keys-prod"
if (-not (Test-Path "$keyDir\jwt-private.pem")) {
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  $js = @"
const { generateKeyPairSync } = require('crypto');
const fs = require('fs');
const k = generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(process.argv[1] + '/jwt-private.pem', k.privateKey, { mode: 0o600 });
fs.writeFileSync(process.argv[1] + '/jwt-public.pem', k.publicKey);
"@
  node -e $js $keyDir
  if ($LASTEXITCODE -ne 0) { throw "key generation failed (is Node installed?)" }
  Write-Host "  created keys-prod\ (git-ignored; keep a backup somewhere safe)"
}
Put-Param JWT_PRIVATE_KEY (Get-Content "$keyDir\jwt-private.pem" -Raw)
Put-Param JWT_PUBLIC_KEY (Get-Content "$keyDir\jwt-public.pem" -Raw)

Write-Host ""
Write-Host "Done. List:   aws ssm get-parameters-by-path --path $prefix --profile $Profile --region $Region --query 'Parameters[].Name'"
Write-Host "Admin login (Swagger /docs, /jaeger, /mail): user 'admin', password:"
Write-Host "  aws ssm get-parameter --name $prefix/ADMIN_PASSWORD --with-decryption --query Parameter.Value --output text --profile $Profile --region $Region"
Write-Host "Grafana (/grafana): user 'admin', password: same command with GRAFANA_ADMIN_PASSWORD"
