# Rotate the GitHub Actions AWS key for the shopflow-ci user.
# - Deletes ALL old keys of shopflow-ci
# - Creates 1 new key
# - Saves it as GitHub secrets AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# The key is never printed. Run every 90 days, or after any leak.
#
# Usage (from repo root):  .\scripts\rotate-ci-key.ps1
param(
  [string]$Profile = "shopflow",
  [string]$User = "shopflow-ci"
)
$ErrorActionPreference = "Stop"

gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw "gh is not logged in. Run: gh auth login" }

Write-Host "1/3 Deleting old keys of $User ..."
$old = aws iam list-access-keys --user-name $User --profile $Profile --output json | ConvertFrom-Json
foreach ($key in $old.AccessKeyMetadata) {
  aws iam delete-access-key --user-name $User --access-key-id $key.AccessKeyId --profile $Profile
  Write-Host "    deleted $($key.AccessKeyId)"
}

Write-Host "2/3 Creating a new key ..."
$k = aws iam create-access-key --user-name $User --profile $Profile --output json | ConvertFrom-Json

Write-Host "3/3 Saving to GitHub secrets ..."
$k.AccessKey.AccessKeyId     | gh secret set AWS_ACCESS_KEY_ID
$k.AccessKey.SecretAccessKey | gh secret set AWS_SECRET_ACCESS_KEY
Remove-Variable k

Write-Host ""
Write-Host "Done. Check:"
aws iam list-access-keys --user-name $User --profile $Profile --query "AccessKeyMetadata[].{Id:AccessKeyId,Status:Status}" --output table
gh secret list
