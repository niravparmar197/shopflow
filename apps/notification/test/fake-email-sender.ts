import { randomUUID } from 'node:crypto';
import type { EmailSender, OutgoingEmail } from '../src/email/email-sender';

const refused = () =>
  Object.assign(new Error('connect ECONNREFUSED (fake)'), {
    code: 'ECONNREFUSED',
  });

/** Stands in for SMTP: records what was sent, and can fail on purpose. */
export class FakeEmailSender implements EmailSender {
  sent: OutgoingEmail[] = [];
  calls = 0;
  mode: 'ok' | 'down' | 'reject' = 'ok';
  /** Fail the next N calls (temporary error), then work. */
  failNext = 0;

  reset() {
    this.sent = [];
    this.calls = 0;
    this.mode = 'ok';
    this.failNext = 0;
  }

  send(msg: OutgoingEmail) {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(refused());
    }
    if (this.mode === 'down') return Promise.reject(refused());
    if (this.mode === 'reject') {
      return Promise.reject(
        Object.assign(new Error('550 mailbox unavailable (fake)'), {
          responseCode: 550,
        }),
      );
    }
    this.sent.push(msg);
    return Promise.resolve({ messageId: `<${randomUUID()}@fake>` });
  }
}
