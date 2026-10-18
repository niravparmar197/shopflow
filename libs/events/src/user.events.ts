import { z } from 'zod';

/**
 * Account events (Phase 2 P3). The user service writes them to its outbox;
 * the notification service turns them into emails.
 *
 * The reset and verify events carry the RAW one-time token, because the
 * email must contain the link. That is acceptable here: the token lives
 * 30 min (reset) or 24 h (verify), works once, and only its SHA-256 hash is
 * stored in the database. The notification log never stores it.
 */
export const UserEvents = {
  PASSWORD_RESET_REQUESTED: 'user.password-reset-requested',
  EMAIL_VERIFICATION_REQUESTED: 'user.email-verification-requested',
  PASSWORD_CHANGED: 'user.password-changed', // security notice
} as const;

const Recipient = {
  userId: z.uuid(),
  email: z.email(),
  fullName: z.string().nullable(),
};

export const PasswordResetRequestedV1Schema = z.object({
  ...Recipient,
  token: z.string().min(20),
  expiresAt: z.string(), // ISO time
});
export type PasswordResetRequestedV1 = z.infer<
  typeof PasswordResetRequestedV1Schema
>;

export const EmailVerificationRequestedV1Schema = z.object({
  ...Recipient,
  token: z.string().min(20),
  expiresAt: z.string(),
});
export type EmailVerificationRequestedV1 = z.infer<
  typeof EmailVerificationRequestedV1Schema
>;

export const PasswordChangedV1Schema = z.object({
  ...Recipient,
  via: z.enum(['RESET', 'CHANGE']), // forgot-password link or account page
});
export type PasswordChangedV1 = z.infer<typeof PasswordChangedV1Schema>;
