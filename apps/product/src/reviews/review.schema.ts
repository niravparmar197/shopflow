import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** One customer's review of one product (Phase 2 P5). */
@Schema({ timestamps: true, collection: 'reviews', versionKey: false })
export class Review {
  @Prop({ required: true })
  productId!: string; // the product's _id as a string

  @Prop({ required: true })
  userId!: string;

  /** Shown with the review, e.g. "Asha P." */
  @Prop({ required: true, trim: true })
  authorName!: string;

  @Prop({ required: true, min: 1, max: 5 })
  rating!: number;

  @Prop({ default: '', trim: true })
  title!: string;

  @Prop({ required: true, trim: true })
  body!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type ReviewDocument = HydratedDocument<Review>;
export const ReviewSchema = SchemaFactory.createForClass(Review);

// One review per customer per product: the unique index is the real guard.
ReviewSchema.index({ productId: 1, userId: 1 }, { unique: true });
// Newest first, with _id as the cursor's tie-breaker.
ReviewSchema.index({ productId: 1, createdAt: -1, _id: -1 });
