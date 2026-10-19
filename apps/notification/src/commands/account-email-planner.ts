import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@app/common';
import {
  type EmailVerificationRequestedV1,
  type EventEnvelope,
  type PasswordChangedV1,
  type PasswordResetRequestedV1,
  UserEvents,
} from '@app/events';
import type { NotificationCommand } from './notification-command';
import { type EmailTemplate, SendEmailCommand } from './send-email.command';

/**
 * user-events → account emails (Phase 2 P3). Unlike order emails, the
 * address comes in the event itself: no projection to look up.
 *
 * Links put the token after "#", not "?": the part after # never leaves
 * the browser, so the token is not written to web server or CDN logs.
 */
@Injectable()
export class AccountEmailPlanner {
  private readonly webUrl: string;

  constructor(config: ConfigService<Env, true>) {
    this.webUrl = config.get('WEB_URL', { infer: true }).replace(/\/+$/, '');
  }

  commandsFor(e: EventEnvelope): NotificationCommand[] {
    const d = e.data as {
      userId: string;
      email: string;
      fullName: string | null;
    };
    const email = (
      template: EmailTemplate,
      vars: Record<string, string | number>,
    ) => [
      new SendEmailCommand(
        e.eventId,
        { userId: d.userId },
        { to: d.email, template, vars: { name: d.fullName ?? '', ...vars } },
      ),
    ];
    const link = (path: string, token?: string) =>
      `${this.webUrl}${path}${token ? `#token=${encodeURIComponent(token)}` : ''}`;

    switch (e.type) {
      case UserEvents.PASSWORD_RESET_REQUESTED:
        return email('password-reset', {
          link: link('/reset-password', (d as PasswordResetRequestedV1).token),
        });
      case UserEvents.EMAIL_VERIFICATION_REQUESTED:
        return email('verify-email', {
          link: link(
            '/verify-email',
            (d as EmailVerificationRequestedV1).token,
          ),
        });
      case UserEvents.PASSWORD_CHANGED:
        return email('password-changed', {
          via: (d as PasswordChangedV1).via,
          link: link('/forgot-password'),
        });
      default:
        return [];
    }
  }
}
