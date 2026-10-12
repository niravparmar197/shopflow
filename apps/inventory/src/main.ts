import { NestFactory } from '@nestjs/core';
import { InventoryModule } from './inventory.module';

async function bootstrap() {
  const app = await NestFactory.create(InventoryModule);
  await app.listen(process.env.PORT ?? 3003);
}
bootstrap();
