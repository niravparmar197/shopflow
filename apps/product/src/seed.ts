// Fills products_db with 60 sample products for local development.
// Run with: npm run seed:product
import mongoose from 'mongoose';
import { ProductSchema } from './products/product.schema';

const CATEGORIES = ['phones', 'laptops', 'shoes', 'shirts', 'watches'];

async function seed() {
  try {
    process.loadEnvFile('apps/product/.env');
  } catch {
    // No .env file: rely on MONGO_URL already being set.
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed (and wipe) a production database');
  }
  const url = process.env.MONGO_URL;
  if (!url) throw new Error('MONGO_URL is not set for the product service');

  await mongoose.connect(url);
  const Product = mongoose.model('Product', ProductSchema);
  await Product.syncIndexes();
  await Product.deleteMany({});

  const docs = Array.from({ length: 60 }, (_, i) => {
    const category = CATEGORIES[i % CATEGORIES.length];
    return {
      name: `Product ${i + 1}`,
      slug: `product-${i + 1}`,
      description: `Great ${category} item number ${i + 1}`,
      category,
      pricePaise: (500 + i * 137) * 100,
      attributes: category === 'phones' ? { ram: '8GB' } : { size: 'M' },
    };
  });
  // One at a time so each gets a distinct createdAt, like real data.
  for (const doc of docs) await Product.create(doc);
  console.log(`Seeded ${docs.length} products`);
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
