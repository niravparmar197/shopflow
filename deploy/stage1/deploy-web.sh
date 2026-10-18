#!/bin/bash
# Deploy ONLY the web app (shell + micro frontends) on the Stage 1 box.
# Run as root by SSM Run Command from the shopflow-frontend deploy workflow:
#   sudo bash /opt/shopflow/releases/$(cat /opt/shopflow/current)/deploy-web.sh <web-image-tag>
#
# The backend stays as it is: same release folder, same .env, only the `web`
# container is replaced. On failure it goes back to the previous web tag and
# exits 1. The workflow writes the new tag to SSM (WEB_IMAGE_TAG) only after
# this script succeeds, so a later backend deploy (deploy.sh) keeps a good tag.
set -euo pipefail

TAG="${1:?usage: deploy-web.sh <web-image-tag>}"
[[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad tag: $TAG"; exit 1; }
REGION=ap-southeast-2
ROOT=/opt/shopflow
SHARED="$ROOT/shared"
HEALTH_TIMEOUT=120

log() { echo "[deploy-web $(date -u +%H:%M:%S)] $*"; }

# Never at the same time as a backend deploy (same lock as deploy.sh).
exec 9>"$ROOT/deploy.lock"
flock -w 600 9 || { log "another deploy is still running"; exit 1; }

[ -f "$ROOT/current" ] && [ -f "$SHARED/.env" ] || { log "no backend release on this box yet: deploy the backend first"; exit 1; }
RELEASE="$ROOT/releases/$(cat "$ROOT/current")"
grep -q '^  web:' "$RELEASE/docker-compose.yml" || { log "the live backend release has no web service: deploy the backend first"; exit 1; }

env_get() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$SHARED/.env"; }
env_set() {
  if grep -q "^$1=" "$SHARED/.env"; then
    sed -i "s/^$1=.*/$1='$2'/" "$SHARED/.env"
  else
    echo "$1='$2'" >> "$SHARED/.env"
  fi
}

REGISTRY=$(env_get REGISTRY)
DOMAIN=$(env_get DOMAIN)
PREVIOUS=$(env_get WEB_IMAGE_TAG)
compose() { docker compose -p shopflow -f "$RELEASE/docker-compose.yml" --env-file "$SHARED/.env" --profile web "$@"; }

wait_web() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) cid state
  while :; do
    cid=$(compose ps -q web 2>/dev/null || true)
    state=$( [ -n "$cid" ] && docker inspect -f '{{.State.Health.Status}}' "$cid" || echo missing)
    # Healthy container AND the page through Caddy (TLS + routing), resolved locally.
    if [ "$state" = healthy ] &&
      curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/mfe-manifest.json" >/dev/null 2>&1; then
      return 0
    fi
    if [ $SECONDS -ge $deadline ]; then
      log "web NOT healthy after ${HEALTH_TIMEOUT}s (state: $state)"
      return 1
    fi
    sleep 3
  done
}

log "ECR login $REGISTRY"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

log "web $TAG (previous: ${PREVIOUS:-none})"
env_set WEB_IMAGE_TAG "$TAG"
if compose pull --quiet web && compose up -d --no-deps web && wait_web; then
  log "OK: web $TAG is live at https://$DOMAIN"
  exit 0
fi

log "FAILED: web $TAG. Last logs:"
compose logs --tail 40 web || true
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != none ] && [ "$PREVIOUS" != "$TAG" ]; then
  log "ROLLBACK to web $PREVIOUS"
  env_set WEB_IMAGE_TAG "$PREVIOUS"
  compose up -d --no-deps web && wait_web && log "rolled back to $PREVIOUS" || log "ROLLBACK FAILED too: check the box (SSM shell)"
else
  env_set WEB_IMAGE_TAG "${PREVIOUS:-none}"
  compose rm -sf web || true
fi
exit 1
