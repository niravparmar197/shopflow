import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type NotificationStatus = 'QUEUED' | 'SENT' | 'FAILED';
export type NotificationChannel = 'email' | 'sms';

/** One row per notification: what was sent, to whom, and how it went. */
@Schema({ collection: 'notification_logs', timestamps: true })
export class NotificationLog {
  @Prop({ required: true })
  key!: string; // = the BullMQ job id (<eventId>-<channel>-<template>)

  @Prop({ required: true })
  eventId!: string;

  // One of the two: what the email is about.
  @Prop()
  orderId?: string;

  @Prop()
  userId?: string; // account emails (Phase 2 P3)

  @Prop({ type: String, required: true })
  channel!: NotificationChannel;

  @Prop({ required: true })
  template!: string;

  @Prop({ required: true })
  to!: string;

  @Prop({ type: String, required: true, default: 'QUEUED' })
  status!: NotificationStatus;

  @Prop({ default: 0 })
  attempts!: number;

  @Prop()
  lastError?: string;

  @Prop()
  sentAt?: Date;

  // Set by `timestamps: true`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type NotificationLogDocument = HydratedDocument<NotificationLog>;
export const NotificationLogSchema =
  SchemaFactory.createForClass(NotificationLog);
// One log per notification (also a dedupe guard for a redelivered event).
NotificationLogSchema.index({ key: 1 }, { unique: true });
// "What did we send for this order?"
NotificationLogSchema.index({ orderId: 1, createdAt: -1 });
// "What did we send to this account?" (sparse: order logs have no userId)
NotificationLogSchema.index({ userId: 1, createdAt: -1 }, { sparse: true });
// Find the FAILED ones fast.
NotificationLogSchema.index({ status: 1, updatedAt: -1 });
