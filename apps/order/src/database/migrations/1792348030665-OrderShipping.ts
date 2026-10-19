import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderShipping1792348030665 implements MigrationInterface {
  name = 'OrderShipping1792348030665';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "shipping_address" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "carrier" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "tracking_number" character varying(60)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "tracking_number"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "carrier"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "shipping_address"`,
    );
  }
}
