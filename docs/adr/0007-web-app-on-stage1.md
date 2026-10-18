# ADR 0007: The web app on Stage 1: its own image, one origin through Caddy

**Status:** Accepted (18 Oct 2026)

## Context
- The web shop ([shopflow-frontend](https://github.com/niravparmar197/shopflow-frontend)) is a
  separate repo: a shell + 3 micro frontends, built to static files (`dist-web/`).
- The refresh cookie is `httpOnly`, `SameSite=strict`, `path=/v1/auth`. The UI and `/v1` must be
  on **one origin**, or the browser never sends the cookie and every reload logs the user out.
- Stage 1 is one EC2 box behind Caddy; backend releases use ONE image tag (the backend git SHA).
- A UI change should not need a backend release, and the reverse.

## Decision
- **Own image:** `shopflow/web:<frontend git sha>` (nginx, non-root, static files only), built,
  Trivy-scanned and pushed by the frontend repo's `release-image` workflow. ECR repo from
  `infra/terraform/bootstrap` (`var.apps`), so the CI user can push it with no extra policy.
- **One origin:** Caddy sends `/v1/*`, `/health*` and `/docs*` to the gateway,
  `/assets/products/*` to MinIO, the admin UIs as before, and **everything else to `web`**.
  No CORS, and the cookie works unchanged.
- **Own tag, kept in SSM:** `/shopflow/prod/WEB_IMAGE_TAG` (Terraform: `stage1/web.tf`, created as
  `none`; `ignore_changes` so Terraform never resets it). The frontend deploy writes it;
  `deploy.sh` reads it, so a backend deploy keeps the live web version.
- **Own deploy:** the frontend `deploy-stage1` workflow runs `deploy-web.sh` (shipped in the
  backend bundle) through SSM Run Command. It replaces only the `web` container, checks it
  through Caddy, and rolls back to the previous web tag on failure. Same lock as `deploy.sh`.
- **Compose profile `web`:** while the tag is `none`, the `web` service is left out, so backend
  deploys never depend on a web release existing.

## Consequences
- (+) UI and API release on their own; a rollback of one never touches the other
  (web: run the frontend `deploy-stage1` with an older tag).
- (+) Same security story as the backend images: immutable tags, Trivy gate, no SSH, least-privilege CI user.
- (-) Two tags to know when you debug ("which web + which backend is live?"):
  `cat /opt/shopflow/current` and SSM `WEB_IMAGE_TAG`.
- (-) An old web bundle may call a newer API: `/v1` changes must stay backward compatible
  (they already must, for clients with an open tab).
- Stage 2 (CloudFront + ALB) is out of scope here: there the web app would be S3 + CloudFront,
  with `/v1/*` as a second origin.
