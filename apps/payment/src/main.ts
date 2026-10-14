import './tracing'; // MUST stay first: see tracing.ts
import { bootstrapService } from '@app/common';
import { paymentAppOptions } from './app.setup';
import { PaymentModule } from './payment.module';

void bootstrapService(PaymentModule, paymentAppOptions);
