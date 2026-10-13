import { counter } from '@app/observability';

export const notificationsSent = counter(
  'shopflow_notifications_total',
  'Notifications by template and final status',
  ['template', 'status'], // status: sent | failed
);
