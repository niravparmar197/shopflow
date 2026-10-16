# Can THIS AWS account run Fargate tasks? (Fargate is not on the "new AWS
# experience" Free plan service list, so we test before writing Stage 2.)
# Runs one tiny task (busybox, ~10 s, costs < $0.001), prints the result, cleans up.
#   powershell -ExecutionPolicy Bypass -File .\scripts\probe-fargate.ps1
param([string]$Profile = "shopflow", [string]$Region = "ap-southeast-2")
$ErrorActionPreference = "Continue"
$aws = @("--profile", $Profile, "--region", $Region)

Write-Host "1/5 cluster"
aws ecs create-cluster --cluster-name zz-probe @aws --query cluster.status --output text

Write-Host "2/5 task definition"
$defs = '[{"name":"hello","image":"public.ecr.aws/docker/library/busybox:1.36","command":["sh","-c","echo FARGATE-OK; sleep 5"],"essential":true}]'
$tmp = New-TemporaryFile
[IO.File]::WriteAllText($tmp.FullName, $defs)
$td = aws ecs register-task-definition --family zz-probe --requires-compatibilities FARGATE `
  --network-mode awsvpc --cpu 256 --memory 512 --container-definitions "file://$($tmp.FullName)" `
  @aws --query taskDefinition.taskDefinitionArn --output text
Remove-Item $tmp.FullName
Write-Host "    $td"

Write-Host "3/5 run task (default VPC, public IP to pull the image)"
$subnet = aws ec2 describe-subnets --filters Name=default-for-az,Values=true @aws --query "Subnets[0].SubnetId" --output text
$net = "awsvpcConfiguration={subnets=[$subnet],assignPublicIp=ENABLED}"
$task = aws ecs run-task --cluster zz-probe --launch-type FARGATE --task-definition zz-probe `
  --network-configuration $net @aws --query "tasks[0].taskArn" --output text
if (-not $task -or $task -eq "None") {
  Write-Host "RESULT: run-task FAILED (see the error above). Fargate is probably blocked here." -ForegroundColor Red
} else {
  Write-Host "    $task"
  Write-Host "4/5 waiting for it to finish (up to ~2 min)..."
  aws ecs wait tasks-stopped --cluster zz-probe --tasks $task @aws
  $r = aws ecs describe-tasks --cluster zz-probe --tasks $task @aws `
    --query "tasks[0].{exit:containers[0].exitCode,reason:stoppedReason}" --output json | ConvertFrom-Json
  if ($r.exit -eq 0) { Write-Host "RESULT: FARGATE WORKS (exit 0)" -ForegroundColor Green }
  else { Write-Host "RESULT: task stopped: exit=$($r.exit) reason=$($r.reason)" -ForegroundColor Yellow }
}

Write-Host "5/5 cleanup"
aws ecs deregister-task-definition --task-definition $td @aws --query taskDefinition.status --output text | Out-Null
aws ecs delete-cluster --cluster zz-probe @aws --query cluster.status --output text
