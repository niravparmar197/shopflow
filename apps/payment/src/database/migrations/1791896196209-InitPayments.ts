import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitPayments1791896196209 implements MigrationInterface {
  name = 'InitPayments1791896196209';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "processed_events" ("consumer" character varying(100) NOT NULL, "event_id" uuid NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_270df9e0013dff41bb91d555db4" PRIMARY KEY ("consumer", "event_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "aggregate_type" character varying(40) NOT NULL, "aggregate_id" uuid NOT NULL, "event_type" character varying(60) NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_unpublished" ON "outbox"  ("created_at") WHERE "published_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "user_id" uuid NOT NULL, "amount_paise" integer NOT NULL, "currency" character varying(3) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'PENDING', "provider" character varying(20), "provider_order_id" character varying(100), "provider_payment_id" character varying(100), "last_error" character varying(300), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "version" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_payments_amount" CHECK ("amount_paise" >= 0), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_expiry" ON "payments"  ("expires_at") WHERE "status" = 'PENDING'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payments_provider_order" ON "payments"  ("provider", "provider_order_id") WHERE "provider_order_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payments_order" ON "payments"  ("order_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_payments_order"`);
    await queryRunner.query(`DROP INDEX "public"."uq_payments_provider_order"`);
    await queryRunner.query(`DROP INDEX "public"."idx_payments_expiry"`);
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
    await queryRunner.query(`DROP TABLE "processed_events"`);
  }
}
