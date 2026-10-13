import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentEvents, type PaymentSucceededV1 } from '@app/events';
import { OutboxService } from '@app/kafka';
import { Payment } from '../payments/payment.entity';
import { assertTransition, PaymentStatus } from '../payments/payment-status';
import { RefundService } from '../payments/refund.service';
import { InvalidSignatureError } from '../providers/errors';
import type {
  WebhookHeaders,
  WebhookResult,
} from '../providers/payment-provider';
import { PaymentProviderFactory } from '../providers/provider.factory';

export type WebhookOutcome =
  | 'duplicate'
  | 'succeeded'
  | 'already-succeeded'
  | 'attempt-failed'
  | 'late-success-refund'
  | 'ignored';

/*
 * 1. verify the HMAC on the RAW bytes            → wrong? 401
 * 2. BEGIN
 *      INSERT webhook_events (provider, eventId) → exists? duplicate, 200
 *      SELECT payment ... FOR UPDATE             ← the row lock vs the sweeper
 *      PENDING + success        → SUCCEEDED (+ payment.succeeded)
 *      EXPIRED + success        → REFUND_PENDING (refunded right after)
 *      PENDING + attempt failed → stays PENDING, last_error saved
 *    COMMIT → 200
 *
 * Status codes steer the provider: 2xx = done, anything else = send again.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly providers: PaymentProviderFactory,
    private readonly outbox: OutboxService,
    private readonly refunds: RefundService,
  ) {}

  async handle(
    providerName: string,
    raw: Buffer,
    headers: WebhookHeaders,
  ): Promise<{ received: true; outcome: WebhookOutcome }> {
    const provider = this.providers.get(providerName);

    // 1. Verify BEFORE trusting anything in the body.
    let result: WebhookResult;
    try {
      result = provider.parseWebhook(raw, headers);
    } catch (err) {
      if (err instanceof InvalidSignatureError) {
        this.logger.warn(`Rejected ${providerName} webhook: bad signature`);
        throw new UnauthorizedException({
          code: 'INVALID_SIGNATURE',
          message: 'Invalid signature',
        });
      }
      throw new BadRequestException({
        code: 'INVALID_WEBHOOK',
        message: 'Cannot parse webhook',
      });
    }
    if (result.kind === 'IGNORED') {
      return { received: true, outcome: 'ignored' };
    }

    // 2. Dedupe + lock + state change: ONE transaction.
    const outcome = await this.ds.transaction(
      async (m): Promise<WebhookOutcome> => {
        const fresh = await m.query<{ event_id: string }[]>(
          `INSERT INTO webhook_events (provider, event_id, kind) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING event_id`,
          [provider.name, result.providerEventId, result.kind],
        );
        if (fresh.length === 0) return 'duplicate';

        const repo = m.getRepository(Payment);
        const p = await repo.findOne({
          where: {
            provider: provider.name,
            providerOrderId: result.providerOrderId,
          },
          lock: { mode: 'pessimistic_write' }, // waits for the sweeper, if it holds the row
        });
        if (!p) {
          // Non-2xx → the provider retries later. The rollback also removes
          // the webhook_events row, so the retry is not seen as a duplicate.
          throw new ServiceUnavailableException({
            code: 'PAYMENT_NOT_FOUND_YET',
            message: 'Unknown provider order',
          });
        }

        if (result.kind === 'ATTEMPT_FAILED') {
          // Not final: the user can try another card until the payment expires.
          if (p.status === PaymentStatus.PENDING) {
            p.lastError = result.reason.slice(0, 300);
            await repo.save(p);
          }
          return 'attempt-failed';
        }

        // SUCCEEDED: decided on the status we read UNDER the lock.
        switch (p.status) {
          case PaymentStatus.PENDING:
            assertTransition(p.status, PaymentStatus.SUCCEEDED);
            p.status = PaymentStatus.SUCCEEDED;
            p.providerPaymentId = result.providerPaymentId;
            p.lastError = null;
            await repo.save(p);
            await this.outbox.add<PaymentSucceededV1>(m, {
              aggregateType: 'order',
              aggregateId: p.orderId,
              eventType: PaymentEvents.SUCCEEDED,
              data: {
                paymentId: p.id,
                orderId: p.orderId,
                userId: p.userId,
                amountPaise: p.amountPaise,
                provider: provider.name,
              },
            });
            return 'succeeded';

          case PaymentStatus.EXPIRED:
            // The money came AFTER we gave up and the order is being
            // cancelled → give it back.
            assertTransition(p.status, PaymentStatus.REFUND_PENDING);
            p.status = PaymentStatus.REFUND_PENDING;
            p.providerPaymentId = result.providerPaymentId;
            await repo.save(p);
            return 'late-success-refund';

          case PaymentStatus.SUCCEEDED:
            return 'already-succeeded'; // e.g. two success events for one payment

          default:
            return 'ignored'; // REFUND_PENDING / REFUNDED: already handled
        }
      },
    );

    // 3. Fast path for the refund, after the commit. If it fails, the
    //    sweeper retries it.
    if (outcome === 'late-success-refund') {
      this.refunds
        .processPending()
        .catch((e: Error) =>
          this.logger.error(`Refund fast path failed: ${e.message}`),
        );
    }

    this.logger.log(
      `Webhook ${provider.name} ${result.providerEventId}: ${outcome}`,
    );
    return { received: true, outcome };
  }
}
