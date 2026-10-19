import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { Env } from '@app/common';
import {
  type EmailSender,
  type OutgoingEmail,
  PermanentEmailError,
} from './email-sender';

/**
 * SES errors that no retry can fix: a bad or unverified address, a sending
 * pause on the account. Anything else (throttling, 5xx, network) is
 * temporary and BullMQ retries it with backoff.
 */
const PERMANENT = new Set([
  'MessageRejected', // e.g. a recipient not verified while in the SES sandbox
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
  'NotFoundException', // unknown configuration set or identity
  'BadRequestException',
]);

/**
 * Amazon SES (API v2), Phase 2 P4. No keys in the config: the SDK takes the
 * credentials of the EC2 instance role (Stage 1) or the ECS task role.
 */
@Injectable()
export class SesEmailSender implements EmailSender {
  private readonly client: SESv2Client;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    this.from = config.get('MAIL_FROM', { infer: true });
    this.client = new SESv2Client({
      region: config.get('SES_REGION', { infer: true }),
      maxAttempts: 2, // BullMQ does the real retrying, with backoff
      // Every outgoing call has a timeout.
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
    });
  }

  async send(msg: OutgoingEmail) {
    try {
      const res = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [msg.to] },
          Content: {
            Simple: {
              Subject: { Data: msg.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: msg.text, Charset: 'UTF-8' },
                Html: { Data: msg.html, Charset: 'UTF-8' },
              },
              Headers: Object.entries(msg.headers ?? {}).map(
                ([Name, Value]) => ({ Name, Value }),
              ),
            },
          },
        }),
      );
      return { messageId: res.MessageId ?? '' };
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (PERMANENT.has(name)) {
        throw new PermanentEmailError(
          `SES ${name}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
}
