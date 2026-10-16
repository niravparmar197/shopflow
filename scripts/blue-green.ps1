# Blue-green release of the PAYMENT service on Stage 2 (Stage 2 must be up).
#
#   .\scripts\blue-green.ps1 status              # live colour, tags, traffic per colour
#   .\scripts\blue-green.ps1 deploy [-Tag <sha>] # new image on GREEN (idle: no users, no background work)
#   .\scripts\blue-green.ps1 preview             # test GREEN in production (secret header), users unaffected
#   .\scripts\blue-green.ps1 switch              # LIVE = green: all users at once; blue kept warm
#   .\scripts\blue-green.ps1 rollback            # LIVE = blue again (old version, instantly ready)
#   .\scripts\blue-green.ps1 finish              # blue gets the new image, LIVE = blue, green removed
#
# Each step is a `terraform apply` of 3 small changes (gateway + blue + green task
# definitions), about 2-3 min. Use -SameImage on deploy to demo it without a new release.
param(
  [Parameter(Position = 0, Mandatory)]
  [ValidateSet("status", "deploy", "preview", "switch", "rollback", "finish")] [string]$Action,
  [string]$Tag = "",          # deploy: default = newest payment image in ECR
  [switch]$SameImage,         # deploy: allow the blue image on green (demo)
  [int]$Minutes = 15,         # status: traffic window
  [string]$Profile = "shopflow",
  [string]$Region = "ap-southeast-2"
)
$ErrorActionPreference = "Stop"
$env:AWS_PROFILE = $Profile
$tf = Join-Path (Split-Path -Parent $PSScriptRoot) "infra\terraform\stage2"
$aws = @("--region", $Region)

function Say($m) { Write-Host "[blue-green] $m" -ForegroundColor Cyan }
function TfOut($name) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $v = terraform "-chdir=$tf" output -raw $name 2>$null
  $ErrorActionPreference = $old
  if ($LASTEXITCODE -ne 0) { return $null }; return $v
}
function Ssm($name) {
  aws ssm get-parameter --name "/shopflow/prod/$name" --with-decryption @aws --query Parameter.Value --output text
}
function Short($t) { if ($t) { $t.Substring(0, [Math]::Min(7, $t.Length)) } else { "-" } }
function Apply($blue, $green, $live) {
  Say "apply: blue=$(Short $blue) green=$(Short $green) live=$live"
  terraform "-chdir=$tf" apply -auto-approve -input=false `
    -var "image_tag=$imageTag" -var "payment_blue_tag=$blue" -var "payment_green_tag=$green" `
    -var "payment_live=$live" -var "alert_email=$(Ssm ACME_EMAIL)"
  if ($LASTEXITCODE -ne 0) { throw "terraform apply failed" }
  $svcs = @("gateway", "payment") + $(if ($green) { "payment-green" } else { @() })
  Say "waiting for $($svcs -join ', ') to be stable..."
  aws ecs wait services-stable --cluster shopflow-stage2 --services $svcs @aws
}
function Call($base, $headers) {
  try { (Invoke-WebRequest "$base/v1/payments/$([guid]::NewGuid())" -Headers $headers -UseBasicParsing).Headers['x-served-by'] }
  catch { $_.Exception.Response.Headers['x-served-by'] }
}

$imageTag = TfOut "image_tag"
if (-not $imageTag) { throw "Stage 2 is not up: .\scripts\demo.ps1 stage2 up" }
$blue = TfOut "payment_blue_tag"
$green = TfOut "payment_green_tag"
$live = TfOut "payment_live"

switch ($Action) {
  "status" {
    Say "LIVE: $live    blue: $(Short $blue)    green: $(if ($green) { Short $green } else { 'not deployed' })"
    $query = @'
fields @message
| filter @logStream like /^gateway\// and @message like /x-served-by/
| parse @message '"x-served-by":"*"' as color
| parse @message '"statusCode":*,' as code
| stats count(*) as n by color, code
'@
    $end = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $qid = aws logs start-query --log-group-name /shopflow/stage2 --start-time ($end - 60 * $Minutes) `
      --end-time $end --query-string $query @aws --query queryId --output text
    do { Start-Sleep 2; $r = aws logs get-query-results --query-id $qid @aws | ConvertFrom-Json } while ($r.status -in "Running", "Scheduled")
    $rows = foreach ($row in $r.results) {
      $h = @{}; foreach ($f in $row) { $h[$f.field] = $f.value }
      [pscustomobject]@{ color = $h.color; code = [int]$h.code; n = [int]$h.n }
    }
    if (-not $rows) { Say "no /v1/payments traffic in the last $Minutes min"; break }
    $rows | Group-Object color | ForEach-Object {
      $total = ($_.Group | Measure-Object n -Sum).Sum
      $err = ($_.Group | Where-Object code -ge 500 | Measure-Object n -Sum).Sum
      [pscustomobject]@{ color = $_.Name; requests = $total; "5xx" = [int]$err
        "error %" = [math]::Round(100 * $err / [math]::Max(1, $total), 2) }
    } | Format-Table -AutoSize
  }

  "deploy" {
    if ($live -ne "blue") { throw "green is live: run 'finish' (or 'rollback') before a new deploy" }
    $new = if ($Tag) { $Tag } else {
      aws ecr describe-images --repository-name shopflow/payment @aws `
        --query "sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]" --output text
    }
    if ($new -eq $blue -and -not $SameImage) {
      throw "Newest image ($(Short $new)) is already on blue. Merge a payment change, pass -Tag, or use -SameImage."
    }
    Apply $blue $new "blue"
    Say "GREEN is up with $(Short $new), idle (no users). Next: .\scripts\blue-green.ps1 preview"
  }

  "preview" {
    $idle = if ($live -eq "blue") { "green" } else { "blue" }
    if ($idle -eq "green" -and -not $green) { throw "no green deployment: run 'deploy' first" }
    $base = TfOut "url"
    $email = "bg+$([guid]::NewGuid().ToString('N').Substring(0, 8))@test.com"
    $creds = @{ email = $email; password = 'Passw0rd!x' }
    Invoke-RestMethod -Method Post "$base/v1/auth/signup" -ContentType 'application/json' `
      -Body (($creds + @{ name = 'Blue Green' }) | ConvertTo-Json) | Out-Null
    $token = (Invoke-RestMethod -Method Post "$base/v1/auth/login" -ContentType 'application/json' `
        -Body ($creds | ConvertTo-Json)).accessToken
    $auth = @{ Authorization = "Bearer $token" }
    $normal = 1..3 | ForEach-Object { Call $base $auth }
    $preview = 1..3 | ForEach-Object { Call $base ($auth + @{ 'x-deploy-color' = $idle; 'x-preview-token' = (Ssm ADMIN_PASSWORD) }) }
    Say "normal user requests  -> $($normal -join ', ')   (expected: $live)"
    Say "preview requests      -> $($preview -join ', ')   (expected: $idle)"
    if (($preview | Select-Object -Unique) -eq $idle -and ($normal | Select-Object -Unique) -eq $live) {
      Say "PREVIEW OK: $idle answers in production, users still on $live. Next: switch"
    } else { Write-Host "Unexpected colours: check status / logs before switching." -ForegroundColor Yellow }
  }

  "switch" {
    if (-not $green) { throw "no green deployment: run 'deploy' first" }
    if ($live -eq "green") { throw "green is already live" }
    Apply $blue $green "green"
    Say "LIVE = green ($(Short $green)). Blue ($(Short $blue)) stays warm: 'rollback' if anything looks wrong, 'finish' when happy."
  }

  "rollback" {
    if ($live -ne "green") { throw "blue is already live" }
    Apply $blue $green "blue"
    Say "LIVE = blue ($(Short $blue)) again. Green kept for debugging; 'finish' will NOT promote it - redeploy instead."
  }

  "finish" {
    if (-not $green) { throw "no green deployment" }
    if ($live -ne "green") { throw "green is not live: switch first (or leave green idle and redeploy)" }
    # 1) blue gets the new image while green still serves (blue is idle, no users)
    Apply $green $green "green"
    # 2) all users back on blue (now the same version), green removed
    Apply $green "" "blue"
    Say "done: blue = $(Short $green), green removed. Ready for the next release."
  }
}
