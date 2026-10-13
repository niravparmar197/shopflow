import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { SendEmailPayload } from '../commands/send-email.command';
import { EMAIL_SENDER, type EmailSender } from '../email/email-sender';
import { renderEmail } from '../email/templates';
import type { CommandHandler } from './command-handler';

@Injectable()
export class SendEmailHandler implements CommandHandler<SendEmailPayload> {
  readonly jobName = 'send-email';

  constructor(@Inject(EMAIL_SENDER) private readonly sender: EmailSender) {}

  async execute(p: SendEmailPayload, key: string) {
    const email = renderEmail(p.template, p.vars);
    try {
      await this.sender.send({
        to: p.to,
        ...email,
        headers: { 'X-Notification-Key': key },
      });
    } catch (err) {
      // SMTP 5xx = permanent (bad mailbox, rejected): retrying won't help.
      // 4xx / network errors = temporary → BullMQ retries with backoff.
      const code = (err as { responseCode?: number }).responseCode;
      if (code && code >= 500 && code < 600) {
        throw new UnrecoverableError(`SMTP ${code}: ${describe(err)}`);
      }
      // BullMQ keeps err.message as the failure reason (Bull Board, our log).
      if (err instanceof Error && !err.message) {
        throw new Error(describe(err), { cause: err });
      }
      throw err;
    }
  }
}

/**
 * A readable reason. Some errors have no message: when "localhost" resolves
 * to both ::1 and 127.0.0.1 and both refuse, Node throws an AggregateError
 * with an empty message and the details in .code and .errors.
 */
function describe(err: unknown): string {
  const e = err as {
    message?: string;
    code?: string;
    errors?: { message?: string }[];
  };
  if (e.message) return e.message;
  const inner = (e.errors ?? []).map((x) => x.message).filter(Boolean);
  return [e.code, inner.join('; ')].filter(Boolean).join(': ') || String(err);
}
