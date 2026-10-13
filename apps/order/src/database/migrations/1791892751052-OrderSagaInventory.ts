import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderSagaInventory1791892751052 implements MigrationInterface {
  name = 'OrderSagaInventory1791892751052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "processed_events" ("consumer" character varying(100) NOT NULL, "event_id" uuid NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_270df9e0013dff41bb91d555db4" PRIMARY KEY ("consumer", "event_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "failure_reason" character varying(50)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "failure_reason"`,
    );
    await queryRunner.query(`DROP TABLE "processed_events"`);
  }
}
