import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [CommonModule.forRoot({ serviceName: 'order' })],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
