import './tracing'; // MUST stay first: see tracing.ts
import { bootstrapService } from '@app/common';
import { InventoryModule } from './inventory.module';

void bootstrapService(InventoryModule, { globalPrefix: 'v1' });
