import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@app/events';
import { UserEvents } from '@app/events';
import { renderEmail } from '../email/templates';
import { AccountEmailPlanner } from './account-email-planner';
import type { SendEmailPayload } from './send-email.command';

describe('AccountEmailPlanner', () => {
  const config = { get: () => 'https://shop.example/' };
  const planner = new AccountEmailPlanner(config as never);
  const userId = randomUUID();
  const token = 'tok_abcdefghijklmnopqrstuvwxyz-0123456789AB';

  const event = (type: string, extra: object): EventEnvelope => ({
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    data: { userId, email: 'asha@shop.in', fullName: 'Asha <b>', ...extra },
  });
  const only = (e: EventEnvelope) => {
    const cmds = planner.commandsFor(e);
    expect(cmds).toHaveLength(1);
    return cmds[0];
  };

  it('reset: a link with the token after #, logged by user, no token in the log', () => {
    const cmd = only(
      event(UserEvents.PASSWORD_RESET_REQUESTED, {
        token,
        expiresAt: new Date().toISOString(),
      }),
    );
    const p = cmd.payload as unknown as SendEmailPayload;
    expect(p).toMatchObject({ to: 'asha@shop.in', template: 'password-reset' });
    expect(p.vars.link).toBe(
      `https://shop.example/reset-password#token=${token}`,
    );
    expect(cmd.log).toMatchObject({ userId, template: 'password-reset' });
    expect(cmd.log.orderId).toBeUndefined();
    expect(JSON.stringify(cmd.log)).not.toContain(token);

    const mail = renderEmail(p.template, p.vars);
    expect(mail.text).toContain(p.vars.link);
    expect(mail.html).toContain('Asha &lt;b&gt;'); // escaped
    expect(mail.html).not.toContain('Asha <b>');
  });

  it('verify and password-changed', () => {
    const verify = only(
      event(UserEvents.EMAIL_VERIFICATION_REQUESTED, {
        token,
        expiresAt: new Date().toISOString(),
      }),
    ).payload as unknown as SendEmailPayload;
    expect(verify.template).toBe('verify-email');
    expect(verify.vars.link).toBe(
      `https://shop.example/verify-email#token=${token}`,
    );

    const changed = only(event(UserEvents.PASSWORD_CHANGED, { via: 'RESET' }))
      .payload as unknown as SendEmailPayload;
    expect(changed.template).toBe('password-changed');
    expect(changed.vars.link).toBe('https://shop.example/forgot-password');
    expect(renderEmail(changed.template, changed.vars).subject).toBe(
      'Your ShopFlow password was changed',
    );
  });

  it('ignores other user events', () => {
    expect(planner.commandsFor(event('user.something-new', {}))).toEqual([]);
  });
});
