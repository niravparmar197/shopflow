import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

@Module({
  imports: [CommonModule.forRoot({ serviceName: 'product' })],
  controllers: [ProductController],
  providers: [ProductService],
})
export class ProductModule {}
