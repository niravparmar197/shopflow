import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderExpiry1791910154100 implements MigrationInterface {
  name = 'OrderExpiry1791910154100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "confirmed_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Orders CONFIRMED before this column existed: their best guess is the
    // last update. Without it NULL < x is never true, and the expiry job
    // would never cancel them.
    await queryRunner.query(
      `UPDATE "orders" SET "confirmed_at" = "updated_at" WHERE "status" = 'CONFIRMED'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_confirmed_at" ON "orders"  ("confirmed_at") WHERE "status" = 'CONFIRMED'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_pending_created" ON "orders"  ("created_at") WHERE "status" = 'PENDING'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_orders_pending_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_confirmed_at"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "confirmed_at"`);
  }
}
