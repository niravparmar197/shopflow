import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

// Stock is not here: the inventory service owns it.
// versionKey is off because `version` below is our own optimistic lock.
@Schema({ timestamps: true, collection: 'products', versionKey: false })
export class Product {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string; // URL-friendly id, e.g. "iphone-15-128gb"

  @Prop({ default: '' })
  description!: string;

  @Prop({ required: true, lowercase: true, trim: true })
  category!: string;

  // Money as an integer number of paise, never a float.
  @Prop({
    required: true,
    min: 0,
    validate: {
      validator: Number.isInteger,
      message: 'pricePaise must be an integer',
    },
  })
  pricePaise!: number;

  @Prop({ default: 'INR' })
  currency!: string;

  @Prop({ type: [String], default: [] })
  images!: string[]; // S3 keys (F2 part 4)

  // Differs per category: { ram: "8GB" } for phones, { size: "M" } for shirts.
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  attributes!: Record<string, unknown>;

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ default: 0 })
  version!: number; // optimistic lock: bumped on every update

  createdAt!: Date;
  updatedAt!: Date;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

// Indexes for the queries the service actually runs.
ProductSchema.index({ isActive: 1, category: 1, pricePaise: 1 }); // category + price filter
ProductSchema.index({ isActive: 1, createdAt: -1, _id: -1 }); // newest first + cursor
ProductSchema.index({ name: 'text', description: 'text' }); // simple search
