import { bootstrapService } from '@app/common';
import { orderAppOptions } from './app.setup';
import { OrderModule } from './order.module';

void bootstrapService(OrderModule, orderAppOptions);
