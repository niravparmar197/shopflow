import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderCustomerEmail1791901816798 implements MigrationInterface {
  name = 'OrderCustomerEmail1791901816798';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD "customer_email" character varying(254)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "customer_email"`,
    );
  }
}
