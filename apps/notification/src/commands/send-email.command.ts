import type { NotificationCommand } from './notification-command';

export type EmailTemplate =
  | 'order-paid'
  | 'order-cancelled'
  | 'order-failed'
  | 'payment-refunded'
  | 'order-shipped'
  | 'order-delivered'
  | 'password-reset'
  | 'verify-email'
  | 'password-changed';

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

  /** `about`: the order or the user account the email is about. */
  constructor(
    eventId: string,
    about: { orderId: string } | { userId: string },
    payload: SendEmailPayload,
  ) {
    this.id = `${eventId}-email-${payload.template}`;
    this.payload = { ...payload };
    // vars are NOT logged: account emails carry one-time links.
    this.log = {
      eventId,
      ...about,
      channel: 'email',
      template: payload.template,
      to: payload.to,
    };
  }
}
