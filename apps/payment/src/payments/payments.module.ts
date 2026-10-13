import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentProviderFactory } from '../providers/provider.factory';
import { WebhookEvent } from '../webhooks/webhook-event.entity';
import { WebhookService } from '../webhooks/webhook.service';
import { WebhooksController } from '../webhooks/webhooks.controller';
import { CheckoutService } from './checkout.service';
import { DevController } from './dev.controller';
import { OrderEventsConsumer } from './order-events.consumer';
import { Payment } from './payment.entity';
import { PaymentsController } from './payments.controller';
import { PaymentSweeper } from './payment-sweeper';
import { PaymentsService } from './payments.service';
import { RefundService } from './refund.service';

@Module({
  imports: [TypeOrmModule.forFeature([Payment, WebhookEvent])],
  controllers: [
    PaymentsController,
    WebhooksController, // no JWT: the provider's signature is the auth
    // Fault injection: never in production. (DevController also checks the
    // loaded config, because a NODE_ENV set only in .env isn't in
    // process.env yet when this decorator runs.)
    ...(process.env.NODE_ENV === 'production' ? [] : [DevController]),
  ],
  providers: [
    PaymentsService,
    CheckoutService,
    RefundService,
    WebhookService,
    PaymentSweeper,
    OrderEventsConsumer,
    PaymentProviderFactory,
  ],
  exports: [PaymentProviderFactory],
})
export class PaymentsModule {}
