import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';

@Module({
  imports: [CommonModule.forRoot({ serviceName: 'gateway' })],
  controllers: [GatewayController],
  providers: [GatewayService],
})
export class GatewayModule {}
