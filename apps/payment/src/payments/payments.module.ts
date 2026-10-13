import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentProviderFactory } from '../providers/provider.factory';
import { OrderEventsConsumer } from './order-events.consumer';
import { Payment } from './payment.entity';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Payment])],
  controllers: [PaymentsController],
  providers: [PaymentsService, OrderEventsConsumer, PaymentProviderFactory],
  exports: [PaymentProviderFactory],
})
export class PaymentsModule {}
