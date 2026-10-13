import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * A LOCAL read model (projection) built from order.created. Notification
 * never calls the order or user service: everything it needs to write an
 * email is already here.
 */
@Schema({ collection: 'orders_view', timestamps: true })
export class OrderView {
  @Prop({ type: String, required: true })
  _id!: string; // = orderId

  @Prop({ required: true })
  userId!: string;

  // Missing on orders placed before the email snapshot existed.
  @Prop()
  email?: string;

  @Prop({ required: true })
  totalPaise!: number;

  @Prop({ required: true })
  currency!: string;

  @Prop({ required: true })
  itemCount!: number;

  @Prop({ required: true })
  placedAt!: Date;
}

export type OrderViewDocument = HydratedDocument<OrderView>;
export const OrderViewSchema = SchemaFactory.createForClass(OrderView);
