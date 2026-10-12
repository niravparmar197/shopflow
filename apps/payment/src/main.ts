import { NestFactory } from '@nestjs/core';
import { PaymentModule } from './payment.module';

async function bootstrap() {
  const app = await NestFactory.create(PaymentModule);
  await app.listen(process.env.PORT ?? 3005);
}
bootstrap();
