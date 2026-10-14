# Rebuilds the order_views read model from the Kafka events.
# The view is disposable: fix a projector bug, run this, and it is rebuilt.
#
#   1. STOP the order service first: a consumer group's offsets can only be
#      reset while it has no active members.
#   2. ./scripts/rebuild-order-views.ps1
#   3. Start the order service: it replays order-events + payment-events.
#   4. Orders older than the topic retention (7 days) are gone from Kafka:
#      run scripts/backfill-order-views.sql afterwards for those.
$ErrorActionPreference = 'Stop'
$compose = @('compose', '-f', 'infra/docker-compose.yml')

Write-Host 'Emptying order_views and forgetting the events it has seen...'
docker @compose exec -T postgres psql -U shop -d orders_db -v ON_ERROR_STOP=1 -c `
  "TRUNCATE order_views; DELETE FROM processed_events WHERE consumer = 'order-read-model';"
if ($LASTEXITCODE -ne 0) { throw 'psql failed' }

Write-Host 'Rewinding consumer group order-read-model to the start of the topics...'
docker @compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh `
  --bootstrap-server localhost:9092 --group order-read-model `
  --reset-offsets --to-earliest --topic order-events --topic payment-events --execute
if ($LASTEXITCODE -ne 0) { throw 'Offset reset failed (is the order service still running?)' }

Write-Host 'Done. Start the order service now; then run scripts/backfill-order-views.sql for orders older than 7 days.'
