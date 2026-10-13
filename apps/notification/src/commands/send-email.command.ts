import type { NotificationCommand } from './notification-command';

export type EmailTemplate =
  'order-paid' | 'order-cancelled' | 'order-failed' | 'payment-refunded';

export interface SendEmailPayload {
  to: string;
  template: EmailTemplate;
  vars: Record<string, string | number>;
}

export class SendEmailCommand implements NotificationCommand {
  readonly jobName = 'send-email';
  readonly id: string;
  readonly payload: SendEmailPayload & Record<string, unknown>;
  readonly log: NotificationCommand['log'];

  constructor(eventId: string, orderId: string, payload: SendEmailPayload) {
    this.id = `${eventId}-email-${payload.template}`;
    this.payload = { ...payload };
    this.log = {
      eventId,
      orderId,
      channel: 'email',
      template: payload.template,
      to: payload.to,
    };
  }
}
