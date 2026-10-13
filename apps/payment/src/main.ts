import { bootstrapService } from '@app/common';
import { PaymentModule } from './payment.module';

void bootstrapService(PaymentModule, {
  globalPrefix: 'v1',
  // Webhook signatures are computed over the exact bytes; re-serialised JSON
  // (spaces, key order) would not match. The parsed body is still available.
  rawBody: true,
});
