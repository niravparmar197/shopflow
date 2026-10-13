import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [CommonModule.forRoot({ serviceName: 'payment' })],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
