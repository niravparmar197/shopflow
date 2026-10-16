# ADR 0006: Blue-green releases for the payment service, switched at the gateway

**Status:** Accepted (16 Oct 2026)

## Context
- Payment is the riskiest service to change: a bug can double-charge or lose a payment.
- We want the new version fully running and tested in production BEFORE users reach it, a
  switch with no mixed versions, and a rollback that is instant because the old version is
  still running.
- Payment is internal (Cloud Map name, no load balancer of its own). ALB weighted target
  groups or CodeDeploy blue/green would need an extra internal ALB (~$16/month).

## Decision
- **Blue** = the normal `payment` ECS service; **green** = `payment-green`, only during a release
  (`infra/terraform/stage2/blue-green.tf`).
- The gateway sends ALL users to the live colour (`apps/gateway/src/http/blue-green.ts`).
  A request with `x-deploy-color: <idle>` + `x-preview-token` reaches the idle colour, so the
  new version is smoke tested in production first. Every response has `x-served-by: blue|green`;
  metric `gateway_deploy_requests_total{upstream,color,status_class}`. Webhooks follow the live colour.
- **Only the live colour does background work** (Kafka consumers, payment sweeper, jobs). The
  idle one must not consume events or expire payments, or "idle" would not be idle.
- `scripts/blue-green.ps1 deploy | preview | switch | rollback | finish` drives a release.

## Consequences
- (+) Users never see two versions at once; rollback = point back at blue, which never stopped.
- (+) No extra load balancer.
- (-) A switch changes env on 3 services (gateway + both colours): ~2-3 min rolling deploy, not a
  single atomic flip. A dynamic flag (SSM / Redis) read by the gateway is the next step.
- (-) During the switch both colours may consume for a moment (or neither): fine, because
  consumers are idempotent (processed_events) and Kafka keeps unread events.
- (-) Both colours share one database: migrations must be expand/contract, so blue still works
  after green's migration ran.
- (-) Double cost of payment while green exists (one extra 0.25 vCPU task).
