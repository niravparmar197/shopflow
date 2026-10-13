import { bootstrapService } from '@app/common';
import { ProductModule } from './product.module';

void bootstrapService(ProductModule, { globalPrefix: 'v1' });
