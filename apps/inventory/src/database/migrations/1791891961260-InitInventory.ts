import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitInventory1791891961260 implements MigrationInterface {
  name = 'InitInventory1791891961260';

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
      `CREATE TABLE "reservations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "product_id" character varying(24) NOT NULL, "quantity" integer NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'RESERVED', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_da95cef71b617ac35dc5bcda243" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_reservations_expiry" ON "reservations"  ("expires_at") WHERE "status" = 'RESERVED'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_reservations_order_product" ON "reservations"  ("order_id", "product_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "stock" ("product_id" character varying(24) NOT NULL, "available" integer NOT NULL DEFAULT '0', "reserved" integer NOT NULL DEFAULT '0', "version" integer NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_stock_reserved" CHECK ("reserved" >= 0), CONSTRAINT "chk_stock_available" CHECK ("available" >= 0), CONSTRAINT "PK_375ba760c8cff338fc8c94b416c" PRIMARY KEY ("product_id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "stock"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_reservations_order_product"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_reservations_expiry"`);
    await queryRunner.query(`DROP TABLE "reservations"`);
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
    await queryRunner.query(`DROP TABLE "processed_events"`);
  }
}
