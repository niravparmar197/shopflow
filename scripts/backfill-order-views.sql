-- Fills order_views from the WRITE model for orders whose events are no
-- longer in Kafka (older than the 7-day topic retention). Less detail (no
-- payment status, a one-step timeline), the same shape. Safe to run many
-- times: orders already in the view are left alone.
--
--   Get-Content scripts/backfill-order-views.sql | docker compose -f infra/docker-compose.yml exec -T postgres psql -U shop -d orders_db
--
-- CQRS-lite, not event sourcing: the tables are the truth and events are
-- not kept forever, so a rebuild covers the retention window and this
-- covers the rest.
INSERT INTO order_views (order_id, user_id, status, status_rank, failure_reason,
                         total_paise, currency, item_count, title, placed_at, timeline)
SELECT o.id, o.user_id, o.status,
       CASE o.status WHEN 'PENDING' THEN 1 WHEN 'CONFIRMED' THEN 2 ELSE 3 END,
       o.failure_reason, o.total_paise, o.currency,
       (SELECT sum(i.quantity) FROM order_items i WHERE i.order_id = o.id),
       (SELECT CASE WHEN count(*) = 1 THEN min(i.name)
                    ELSE min(i.name) || ' + ' || (count(*) - 1) || ' more' END
          FROM order_items i WHERE i.order_id = o.id),
       o.created_at,
       -- ISO like the events' occurredAt, so the timeline sorts the same way
       jsonb_build_array(jsonb_build_object(
         'step', 'PLACED',
         'at', to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
FROM orders o
ON CONFLICT (order_id) DO NOTHING;
