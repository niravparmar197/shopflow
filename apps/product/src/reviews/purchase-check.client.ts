import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@app/common';

const TIMEOUT_MS = 2_000;

/**
 * Asks the order service whether a user received a product (only buyers
 * may review). A synchronous call is fine here: it is only on the rare
 * "write a review" path, and reading reviews never depends on it. If the
 * order service is down we FAIL CLOSED (503): better no review than a fake.
 */
@Injectable()
export class PurchaseCheckClient {
  private readonly logger = new Logger(PurchaseCheckClient.name);
  private readonly baseUrl?: string;
  private readonly token?: string;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('ORDER_SERVICE_URL', { infer: true });
    this.token = config.get('INTERNAL_API_TOKEN', { infer: true });
  }

  async hasReceived(userId: string, productId: string): Promise<boolean> {
    if (!this.baseUrl || !this.token) {
      this.logger.error('ORDER_SERVICE_URL / INTERNAL_API_TOKEN not set');
      throw this.unavailable();
    }
    const url = new URL('/v1/internal/purchases', this.baseUrl);
    url.search = new URLSearchParams({ userId, productId }).toString();
    try {
      const res = await fetch(url, {
        headers: { 'x-internal-token': this.token },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`order service answered ${res.status}`);
      return ((await res.json()) as { delivered: boolean }).delivered === true;
    } catch (err) {
      this.logger.warn({ err: err as Error }, 'Purchase check failed');
      throw this.unavailable();
    }
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'PURCHASE_CHECK_UNAVAILABLE',
      message: 'We could not check your order right now. Please try again.',
    });
  }
}
