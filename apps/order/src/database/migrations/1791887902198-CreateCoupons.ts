import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCoupons1791887902198 implements MigrationInterface {
  name = 'CreateCoupons1791887902198';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."coupons_type_enum" AS ENUM('PERCENT', 'FLAT')`,
    );
    await queryRunner.query(
      `CREATE TABLE "coupons" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying(20) NOT NULL, "type" "public"."coupons_type_enum" NOT NULL, "value" integer NOT NULL, "max_discount_paise" integer, "min_cart_paise" integer NOT NULL DEFAULT '0', "category" character varying(50), "first_order_only" boolean NOT NULL DEFAULT false, "valid_from" TIMESTAMP WITH TIME ZONE NOT NULL, "valid_to" TIMESTAMP WITH TIME ZONE NOT NULL, "usage_limit" integer, "used_count" integer NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, "version" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_e025109230e82925843f2a14c48" UNIQUE ("code"), CONSTRAINT "PK_d7ea8864a0150183770f3e9a8cb" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "coupons"`);
    await queryRunner.query(`DROP TYPE "public"."coupons_type_enum"`);
  }
}
