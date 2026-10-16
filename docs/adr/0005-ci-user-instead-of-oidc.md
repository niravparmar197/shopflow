# ADR 0005: CI pushes to ECR with a least-privilege IAM user, not GitHub OIDC

**Status:** Accepted (16 Oct 2026)

## Context
- The plan was GitHub Actions → AWS via OIDC (short-lived role sessions, no stored keys).
- Our AWS account is on the new AWS "projects" experience (Free plan, $120 credits, spend limit).
- In that experience, AWS manages Service Control Policies we cannot change:
  - `DenyIAMRestrictedActions` denies `iam:*Provider*`, so `iam:CreateOpenIDConnectProvider` fails.
  - A Region SCP allows only the project's Region: `ap-southeast-2` (Sydney).
    `ap-south-1` and `us-east-1` were tested and denied, even for the console role `AccountFullAccessRole`.
- The only way to remove these is "Activate advanced features". It needs a paid plan, removes the
  spend limit and cannot be undone.

## Decision
- Stay on the Free plan and keep the spend limit.
- Use Region `ap-southeast-2` (the project Region).
- CI uses a dedicated IAM user `shopflow-ci`:
  - ECR push to our 7 repos only (plus `ecr:GetAuthorizationToken`).
  - No console password.
  - Access key created by hand with the CLI (never in Terraform state), stored only in GitHub secrets.
  - The release workflow runs only on `main`. Secrets are not exposed to fork PRs.
  - Rotate the key every 90 days. Delete it when the project ends.

## Consequences
- (+) No bill-shock risk. Works today.
- (-) A long-lived key exists. Its blast radius is "push images to 7 repos", nothing else.
- (-) Higher latency from India (Sydney, ~150 ms). Fine for a demo.
- If we ever activate advanced features: restore the OIDC role (git history of
  `infra/terraform/bootstrap/github-oidc.tf`) and delete the CI user and key.
