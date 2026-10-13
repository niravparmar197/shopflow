import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrders1791889015976 implements MigrationInterface {
  name = 'CreateOrders1791889015976';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("user_id" uuid NOT NULL, "key" character varying(100) NOT NULL, "request_hash" character(64) NOT NULL, "status" character varying(20) NOT NULL, "response_status" integer, "response_body" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_392b1af86f210d98d3f0c764728" PRIMARY KEY ("user_id", "key"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'PENDING', "subtotal_paise" integer NOT NULL, "discount_paise" integer NOT NULL DEFAULT '0', "total_paise" integer NOT NULL, "coupon_code" character varying(20), "currency" character varying(3) NOT NULL DEFAULT 'INR', "version" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "chk_orders_amounts" CHECK ("discount_paise" >= 0 AND "total_paise" >= 0), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_user_created" ON "orders"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "product_id" character varying(24) NOT NULL, "name" character varying(200) NOT NULL, "unit_price_paise" integer NOT NULL, "quantity" integer NOT NULL, "line_total_paise" integer NOT NULL, CONSTRAINT "chk_order_items_quantity" CHECK ("quantity" > 0), CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_items_order" ON "order_items"  ("order_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "aggregate_type" character varying(40) NOT NULL, "aggregate_id" uuid NOT NULL, "event_type" character varying(60) NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_unpublished" ON "outbox"  ("created_at") WHERE "published_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_145532db85752b29c57d2b7b1f1"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
    await queryRunner.query(`DROP INDEX "public"."idx_order_items_order"`);
    await queryRunner.query(`DROP TABLE "order_items"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_user_created"`);
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
  }
}
