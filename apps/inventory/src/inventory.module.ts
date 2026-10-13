import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [CommonModule.forRoot({ serviceName: 'inventory' })],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
