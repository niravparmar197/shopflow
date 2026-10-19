import { MigrationInterface, QueryRunner } from 'typeorm';

export class Wishlist1792383454395 implements MigrationInterface {
  name = 'Wishlist1792383454395';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "wishlist_items" ("user_id" uuid NOT NULL, "product_id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e0584a3664156caa678765afadc" PRIMARY KEY ("user_id", "product_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3b8ce7bf02c0fc4aa3faffceb9" ON "wishlist_items"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "wishlist_items" ADD CONSTRAINT "FK_549f44d8b756e2690deb099f83b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wishlist_items" DROP CONSTRAINT "FK_549f44d8b756e2690deb099f83b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3b8ce7bf02c0fc4aa3faffceb9"`,
    );
    await queryRunner.query(`DROP TABLE "wishlist_items"`);
  }
}
