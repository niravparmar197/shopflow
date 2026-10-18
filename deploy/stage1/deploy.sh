#!/bin/bash
# Deploy one release on the Stage 1 box. Run as root by SSM Run Command (from the
# deploy-stage1 workflow) or by hand in an SSM shell:
#   sudo bash deploy.sh <image-tag>          (run from the extracted bundle folder)
#
# 1. copy this bundle to /opt/shopflow/releases/<tag>
#    (the web app keeps its own tag: WEB_IMAGE_TAG in SSM, see deploy-web.sh)
# 2. secrets: SSM Parameter Store -> /opt/shopflow/shared/.env (chmod 600) + JWT key files
# 3. pull images from ECR, `compose up` (migrations run first, as one-off jobs)
# 4. wait until every service is healthy and HTTPS answers through Caddy
# 5. on failure: roll back to the last good tag and exit 1
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
REGION=ap-southeast-2
ROOT=/opt/shopflow
SSM_PREFIX=/shopflow/prod
BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE="$ROOT/releases/$TAG"
SHARED="$ROOT/shared"
APPS=(gateway user product order inventory payment notification)
HEALTH_TIMEOUT=420 # seconds; first boot pulls ~1.5 GB of images

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

# Only one deploy at a time (a re-run waits instead of racing).
exec 9>"$ROOT/deploy.lock"
flock -w 600 9 || { log "another deploy is still running"; exit 1; }

# ---------- 1. release folder ----------
mkdir -p "$ROOT/releases" "$SHARED" "$ROOT/keys"
if [ "$BUNDLE_DIR" != "$RELEASE" ]; then
  rm -rf "$RELEASE" && mkdir -p "$RELEASE"
  cp -a "$BUNDLE_DIR/." "$RELEASE/"
fi
cd "$RELEASE"

# ---------- 2. secrets ----------
log "reading secrets from SSM $SSM_PREFIX"
PARAMS_JSON=$(aws ssm get-parameters-by-path --region "$REGION" --path "$SSM_PREFIX" \
  --with-decryption --recursive --output json)
param() { jq -r --arg n "$SSM_PREFIX/$1" '.Parameters[] | select(.Name == $n) | .Value' <<<"$PARAMS_JSON"; }

for required in DUCKDNS_SUBDOMAIN ACME_EMAIL POSTGRES_PASSWORD INTERNAL_API_TOKEN \
  FAKE_WEBHOOK_SECRET MINIO_ROOT_PASSWORD GRAFANA_ADMIN_PASSWORD ADMIN_PASSWORD \
  JWT_PRIVATE_KEY JWT_PUBLIC_KEY; do
  [ -n "$(param "$required")" ] || { log "missing SSM parameter $SSM_PREFIX/$required (run scripts/put-stage1-secrets.ps1)"; exit 1; }
done

# JWT keys as files, readable by the container user (node = uid 1000) only.
umask 077
param JWT_PRIVATE_KEY > "$ROOT/keys/jwt-private.pem"
param JWT_PUBLIC_KEY > "$ROOT/keys/jwt-public.pem"
chown 1000:1000 "$ROOT/keys" "$ROOT/keys/"*.pem
chmod 500 "$ROOT/keys"
chmod 400 "$ROOT/keys/"*.pem

# Caddy wants a bcrypt hash for basic auth, not the plain password.
ADMIN_HASH=$(docker run --rm caddy:2.8.4 caddy hash-password --plaintext "$(param ADMIN_PASSWORD)")

# The web app is released by the frontend repo; keep whatever tag is live.
# "none" (or missing) = no web release yet: leave the web service out.
WEB_TAG=$(param WEB_IMAGE_TAG)
[ -n "$WEB_TAG" ] || WEB_TAG=none
PROFILE_ARGS=()
if [ "$WEB_TAG" != none ]; then
  PROFILE_ARGS=(--profile web)
  APPS+=(web)
fi

REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com"

# Single quotes = literal for compose (bcrypt hashes and passwords contain '$').
q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
{
  echo "# written by deploy.sh from SSM - do not edit"
  echo "IMAGE_TAG=$(q "$TAG")"
  echo "WEB_IMAGE_TAG=$(q "$WEB_TAG")"
  echo "REGISTRY=$(q "$REGISTRY")"
  echo "DOMAIN=$(q "$(param DUCKDNS_SUBDOMAIN).duckdns.org")"
  echo "ACME_EMAIL=$(q "$(param ACME_EMAIL)")"
  echo "ADMIN_PASSWORD_HASH=$(q "$ADMIN_HASH")"
  for k in POSTGRES_PASSWORD INTERNAL_API_TOKEN FAKE_WEBHOOK_SECRET MINIO_ROOT_PASSWORD GRAFANA_ADMIN_PASSWORD; do
    echo "$k=$(q "$(param "$k")")"
  done
  RL=$(param RATE_LIMIT_GLOBAL_PER_MIN); [ -n "$RL" ] && echo "RATE_LIMIT_GLOBAL_PER_MIN=$(q "$RL")"
  true
} > "$SHARED/.env"
chmod 600 "$SHARED/.env"
umask 022
DOMAIN="$(param DUCKDNS_SUBDOMAIN).duckdns.org"

compose() { docker compose -p shopflow -f "$1/docker-compose.yml" --env-file "$SHARED/.env" "${PROFILE_ARGS[@]}" "${@:2}"; }

# Keep DuckDNS pointing at us before Caddy asks Let's Encrypt for a certificate.
/usr/local/bin/duckdns-update || log "WARN: DuckDNS update failed"

# ---------- 3. pull + up ----------
log "ECR login $REGISTRY"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

log "pulling images for $TAG"
compose "$RELEASE" pull --quiet

PREVIOUS=$(cat "$ROOT/current" 2>/dev/null || true)
log "starting $TAG (previous: ${PREVIOUS:-none})"

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) app cid state all_ok
  while :; do
    all_ok=1
    for app in "${APPS[@]}"; do
      cid=$(compose "$RELEASE" ps -q "$app" 2>/dev/null || true)
      state=$( [ -n "$cid" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" || echo missing)
      [ "$state" = healthy ] || { all_ok=0; break; }
    done
    if [ $all_ok = 1 ]; then
      # End to end through Caddy (TLS + routing), resolved locally.
      curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health/ready" >/dev/null 2>&1 && return 0
      app=caddy state="no HTTPS yet (certificate?)"
    fi
    if [ $SECONDS -ge $deadline ]; then
      log "NOT healthy after ${HEALTH_TIMEOUT}s: $app is '$state'"
      return 1
    fi
    sleep 5
  done
}

if compose "$RELEASE" up -d --remove-orphans && wait_healthy; then
  echo "$TAG" > "$ROOT/current"
  [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TAG" ] && echo "$PREVIOUS" > "$ROOT/previous"
  log "OK: $TAG is live at https://$DOMAIN"
else
  log "FAILED: $TAG. Last logs:"
  compose "$RELEASE" ps -a || true
  compose "$RELEASE" logs --tail 40 "${APPS[@]}" || true
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TAG" ] && [ -d "$ROOT/releases/$PREVIOUS" ]; then
    log "ROLLBACK to $PREVIOUS"
    sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG='$PREVIOUS'/" "$SHARED/.env"
    RELEASE="$ROOT/releases/$PREVIOUS"
    compose "$RELEASE" up -d --remove-orphans && wait_healthy \
      && log "rolled back to $PREVIOUS" || log "ROLLBACK FAILED too: check the box (SSM shell)"
  fi
  exit 1
fi

# ---------- housekeeping ----------
# Keep the 3 newest release folders; drop images not used for 3 days.
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
docker image prune -af --filter "until=72h" >/dev/null || true
log "done"
