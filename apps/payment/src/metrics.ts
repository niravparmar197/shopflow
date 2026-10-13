import { counter } from '@app/observability';

// Business metrics. Labels from fixed sets only.

export const payments = counter(
  'shopflow_payments_total',
  'Payments by outcome',
  ['outcome'], // succeeded | expired | refunded
);

export const webhooks = counter(
  'shopflow_webhooks_total',
  'Provider webhooks by outcome',
  // provider is counted only once the factory knows it (no free-text label)
  ['provider', 'outcome'],
);
