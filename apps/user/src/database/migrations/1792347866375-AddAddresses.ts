import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAddresses1792347866375 implements MigrationInterface {
  name = 'AddAddresses1792347866375';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "addresses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "full_name" character varying(100) NOT NULL, "phone" character varying(15) NOT NULL, "line1" character varying(200) NOT NULL, "line2" character varying(200), "city" character varying(100) NOT NULL, "state" character varying(100) NOT NULL, "pincode" character varying(6) NOT NULL, "is_default" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_745d8f43d3af10ab8247465e450" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_addresses_one_default" ON "addresses"  ("user_id") WHERE "is_default"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a2e2d417237527d8b6beb238f2" ON "addresses"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "FK_16aac8a9f6f9c1dd6bcb75ec023" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT "FK_16aac8a9f6f9c1dd6bcb75ec023"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a2e2d417237527d8b6beb238f2"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_addresses_one_default"`);
    await queryRunner.query(`DROP TABLE "addresses"`);
  }
}
