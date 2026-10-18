import { UnrecoverableError } from 'bullmq';
import type { EmailTemplate } from '../commands/send-email.command';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Vars = Record<string, string | number>;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** ALWAYS escape values that go into HTML (no HTML/script injection). */
const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const REASONS: Record<string, string> = {
  PAYMENT_TIMEOUT: 'the payment was not completed in time',
  STOCK_TIMEOUT: 'we could not confirm stock for it in time',
  OUT_OF_STOCK: 'an item in your order went out of stock',
  CARD_DECLINED: 'the card was declined',
  USER_CANCELLED: 'you cancelled it',
  ADMIN_CANCELLED: 'we had to cancel it',
};
const reasonText = (r: unknown) =>
  REASONS[String(r)] ?? 'of a problem with the order';

const layout = (title: string, body: string) => `<!doctype html>
<html><body style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;color:#222">
  <h2 style="margin:0 0 16px">${esc(title)}</h2>
  ${body}
  <p style="color:#888;font-size:12px;margin-top:32px">ShopFlow · automated message, please don't reply</p>
</body></html>`;

const TEMPLATES: Record<EmailTemplate, (v: Vars) => RenderedEmail> = {
  'order-paid': (v) => ({
    subject: `Order ${v.orderNo} is confirmed`,
    text: `Thank you! We received your payment of ${v.currency} ${v.total} for order ${v.orderNo}.`,
    html: layout(
      'Thank you for your order!',
      `<p>We received your payment for order <b>${esc(v.orderNo)}</b>.</p>
  <p>Total paid: <b>${esc(v.currency)} ${esc(v.total)}</b></p>`,
    ),
  }),
  'order-cancelled': (v) => ({
    subject: `Order ${v.orderNo} was cancelled`,
    text: `Your order ${v.orderNo} was cancelled because ${reasonText(v.reason)}. You were not charged; if money was taken, it is refunded automatically.`,
    html: layout(
      'Your order was cancelled',
      `<p>Order <b>${esc(v.orderNo)}</b> was cancelled because ${esc(reasonText(v.reason))}.</p>
  <p>You were not charged. If money was taken, it is refunded automatically.</p>`,
    ),
  }),
  'order-failed': (v) => ({
    subject: `We could not place order ${v.orderNo}`,
    text: `Sorry, we could not place order ${v.orderNo} because ${reasonText(v.reason)}.`,
    html: layout(
      'We could not place your order',
      `<p>Sorry, order <b>${esc(v.orderNo)}</b> could not be placed because ${esc(reasonText(v.reason))}.</p>`,
    ),
  }),
  'order-shipped': (v) => ({
    subject: `Order ${v.orderNo} is on its way`,
    text: `Good news: order ${v.orderNo} has shipped${v.carrier ? ` with ${v.carrier}` : ''}.${v.trackingNumber ? ` Tracking number: ${v.trackingNumber}.` : ''}`,
    html: layout(
      'Your order is on its way',
      `<p>Order <b>${esc(v.orderNo)}</b> has shipped${v.carrier ? ` with <b>${esc(v.carrier)}</b>` : ''}.</p>${
        v.trackingNumber
          ? `\n  <p>Tracking number: <b>${esc(v.trackingNumber)}</b></p>`
          : ''
      }`,
    ),
  }),
  'order-delivered': (v) => ({
    subject: `Order ${v.orderNo} was delivered`,
    text: `Order ${v.orderNo} was delivered. Thank you for shopping with ShopFlow!`,
    html: layout(
      'Delivered!',
      `<p>Order <b>${esc(v.orderNo)}</b> was delivered. Thank you for shopping with ShopFlow!</p>`,
    ),
  }),
  'payment-refunded': (v) => ({
    subject: `Refund for order ${v.orderNo}`,
    text: `We refunded ${v.currency} ${v.amount} for order ${v.orderNo}. It may take 5-7 working days to appear.`,
    html: layout(
      'Your refund is on the way',
      `<p>We refunded <b>${esc(v.currency)} ${esc(v.amount)}</b> for order <b>${esc(v.orderNo)}</b>.</p>
  <p>It may take 5–7 working days to show in your account.</p>`,
    ),
  }),
};

export function renderEmail(template: string, vars: Vars): RenderedEmail {
  // hasOwn: a name like "constructor" must not hit Object.prototype.
  if (!Object.hasOwn(TEMPLATES, template)) {
    // A missing template never works, however often we retry → fail now.
    throw new UnrecoverableError(`Unknown email template "${template}"`);
  }
  return TEMPLATES[template as EmailTemplate](vars);
}
