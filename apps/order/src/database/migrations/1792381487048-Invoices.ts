import { MigrationInterface, QueryRunner } from 'typeorm';

export class Invoices1792381487048 implements MigrationInterface {
  name = 'Invoices1792381487048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "invoices" ("order_id" uuid NOT NULL, "number" character varying(16) NOT NULL, "financial_year" character varying(7) NOT NULL, "seq" integer NOT NULL, "gst_rate_percent" numeric(5,2) NOT NULL, "seller_state" character varying(50) NOT NULL, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_6b20aa66f2a835a4f2fbde48724" UNIQUE ("number"), CONSTRAINT "PK_ea83c3b911906a3578de2340fdf" PRIMARY KEY ("order_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "invoice_counters" ("financial_year" character varying(7) NOT NULL, "last_seq" integer NOT NULL, CONSTRAINT "PK_31d82057f2b7fab4f61195ff7e5" PRIMARY KEY ("financial_year"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD CONSTRAINT "FK_ea83c3b911906a3578de2340fdf" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invoices" DROP CONSTRAINT "FK_ea83c3b911906a3578de2340fdf"`,
    );
    await queryRunner.query(`DROP TABLE "invoice_counters"`);
    await queryRunner.query(`DROP TABLE "invoices"`);
  }
}
