import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kafka } from 'kafkajs';
import type { Env } from '@app/common';
import {
  type EventEnvelope,
  OrderCancelledV1Schema,
  type OrderCreatedV1,
  OrderCreatedV1Schema,
  OrderEvents,
  OrderFailedV1Schema,
  OrderPaidV1Schema,
  PaymentEvents,
  PaymentRefundedV1Schema,
  Topics,
} from '@app/events';
import {
  KAFKA_CLIENT,
  KafkaConsumerCore,
  KafkaProducerService,
} from '@app/kafka';
import { CommandDispatcher } from './commands/command-dispatcher';
import { NotificationPlanner } from './commands/notification-planner';
import { ProjectionService } from './projection/projection.service';

/**
 * order.created → the projection; the other events → notification commands
 * on the queue. No Postgres here, so no processed_events: duplicates are
 * stopped by the projection's upsert, the BullMQ job id and the log's
 * unique key.
 */
@Injectable()
export class NotificationsConsumer extends KafkaConsumerCore {
  protected readonly topics = [Topics.ORDER_EVENTS, Topics.PAYMENT_EVENTS];
  protected readonly groupId = 'notification-svc';
  // A NEW notification service must not email customers about every old
  // order still in Kafka. Stateful services catch up; this one must not.
  protected readonly fromBeginning = false;
  protected readonly schemas = {
    [OrderEvents.CREATED]: OrderCreatedV1Schema,
    [OrderEvents.PAID]: OrderPaidV1Schema,
    [OrderEvents.CANCELLED]: OrderCancelledV1Schema,
    [OrderEvents.FAILED]: OrderFailedV1Schema,
    [PaymentEvents.REFUNDED]: PaymentRefundedV1Schema,
  };

  constructor(
    @Inject(KAFKA_CLIENT) kafka: Kafka,
    producer: KafkaProducerService,
    config: ConfigService<Env, true>,
    private readonly projection: ProjectionService,
    private readonly planner: NotificationPlanner,
    private readonly dispatcher: CommandDispatcher,
  ) {
    super(kafka, producer, config);
  }

  protected async processEvent(e: EventEnvelope) {
    if (e.type === OrderEvents.CREATED) {
      await this.projection.upsertOrder(e.data as OrderCreatedV1, e.occurredAt);
      return;
    }

    const { orderId } = e.data as { orderId: string };
    const view = await this.projection.get(orderId);
    if (!view) {
      // order.created normally comes first (same key → same partition).
      // After a retry-topic reorder it may not be here yet: a TEMPORARY
      // error → retry topic, then the DLQ if it never shows up.
      throw new Error(`Order ${orderId} not in projection yet`);
    }

    for (const cmd of this.planner.commandsFor(e, view)) {
      await this.dispatcher.dispatch(cmd);
    }
  }
}
