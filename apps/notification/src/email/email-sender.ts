import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '@app/common';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

/** The seam for providers: SMTP (Mailpit locally) or SES (Phase 2 P4). */
export interface EmailSender {
  send(msg: OutgoingEmail): Promise<{ messageId: string }>;
}

/** Retrying won't help (rejected address, unverified sender): fail now. */
export class PermanentEmailError extends Error {
  override readonly name = 'PermanentEmailError';
}

@Injectable()
export class SmtpEmailSender implements EmailSender, OnModuleDestroy {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    this.from = config.get('MAIL_FROM', { infer: true });
    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', { infer: true }) ?? 'localhost',
      port: config.get('SMTP_PORT', { infer: true }) ?? 1025,
      secure: false,
      pool: true, // reuse SMTP connections
      maxConnections: 5,
      // Every outgoing call has a timeout.
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async send(msg: OutgoingEmail) {
    const info = (await this.transporter.sendMail({
      from: this.from,
      ...msg,
    })) as { messageId: string };
    return { messageId: info.messageId };
  }

  onModuleDestroy() {
    this.transporter.close(); // the pool's open connections
  }
}
