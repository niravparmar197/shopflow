import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderViews1791956673352 implements MigrationInterface {
  name = 'OrderViews1791956673352';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "order_views" ("order_id" uuid NOT NULL, "user_id" uuid, "status" character varying(20) NOT NULL, "status_rank" integer NOT NULL DEFAULT '0', "payment_status" character varying(20), "failure_reason" character varying(50), "total_paise" integer, "currency" character varying(3), "item_count" integer, "title" character varying(300), "timeline" jsonb NOT NULL DEFAULT '[]'::jsonb, "placed_at" TIMESTAMP WITH TIME ZONE, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d007e3f04dcb7e01cf3b6c602fb" PRIMARY KEY ("order_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_views_user_placed" ON "order_views"  ("user_id", "placed_at", "order_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_order_views_user_placed"`,
    );
    await queryRunner.query(`DROP TABLE "order_views"`);
  }
}
