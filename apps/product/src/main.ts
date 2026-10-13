import { bootstrapService } from '@app/common';
import { productAppOptions } from './app.setup';
import { ProductModule } from './product.module';

void bootstrapService(ProductModule, productAppOptions);
