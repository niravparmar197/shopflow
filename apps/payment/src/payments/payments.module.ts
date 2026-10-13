import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentProviderFactory } from '../providers/provider.factory';
import { CheckoutService } from './checkout.service';
import { DevController } from './dev.controller';
import { OrderEventsConsumer } from './order-events.consumer';
import { Payment } from './payment.entity';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Payment])],
  controllers: [
    PaymentsController,
    // Fault injection: never in production. (DevController also checks the
    // loaded config, because a NODE_ENV set only in .env isn't in
    // process.env yet when this decorator runs.)
    ...(process.env.NODE_ENV === 'production' ? [] : [DevController]),
  ],
  providers: [
    PaymentsService,
    CheckoutService,
    OrderEventsConsumer,
    PaymentProviderFactory,
  ],
  exports: [PaymentProviderFactory],
})
export class PaymentsModule {}
