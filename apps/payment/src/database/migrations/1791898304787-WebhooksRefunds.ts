import { MigrationInterface, QueryRunner } from 'typeorm';

export class WebhooksRefunds1791898304787 implements MigrationInterface {
  name = 'WebhooksRefunds1791898304787';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "webhook_events" ("provider" character varying(20) NOT NULL, "event_id" character varying(100) NOT NULL, "kind" character varying(20) NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_f7f654109e5cf7f541d8a9b6945" PRIMARY KEY ("provider", "event_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "refund_attempted_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "refund_attempted_at"`,
    );
    await queryRunner.query(`DROP TABLE "webhook_events"`);
  }
}
