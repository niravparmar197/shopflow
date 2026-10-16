#!/bin/bash
# Build the Stage 1 deploy bundle (everything the box needs except images and secrets).
#   bash deploy/stage1/package.sh out/stage1-bundle.tgz      (run from the repo root)
set -euo pipefail
OUT="${1:?usage: package.sh <out.tgz>}"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp -r deploy/stage1/. "$STAGE/"
rm -f "$STAGE/package.sh"
mkdir -p "$STAGE/postgres" "$STAGE/scripts" "$STAGE/alertmanager" "$STAGE/grafana"
cp infra/postgres/init.sql "$STAGE/postgres/"
cp infra/prometheus/alerts.yml "$STAGE/prometheus/"
cp infra/alertmanager/alertmanager.yml "$STAGE/alertmanager/"
cp -r infra/grafana/provisioning infra/grafana/dashboards "$STAGE/grafana/"
cp scripts/kafka-topics.js "$STAGE/scripts/"
chmod +x "$STAGE/deploy.sh"

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$STAGE" .
echo "bundle: $OUT ($(du -h "$OUT" | cut -f1))"
tar -tzf "$OUT" | sort
