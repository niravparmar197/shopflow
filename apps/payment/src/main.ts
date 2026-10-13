import { bootstrapService } from '@app/common';
import { PaymentModule } from './payment.module';

void bootstrapService(PaymentModule, { globalPrefix: 'v1' });
