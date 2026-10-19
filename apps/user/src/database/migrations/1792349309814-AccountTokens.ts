import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccountTokens1792349309814 implements MigrationInterface {
  name = 'AccountTokens1792349309814';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "outbox" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "aggregate_type" character varying(40) NOT NULL, "aggregate_id" uuid NOT NULL, "event_type" character varying(60) NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_unpublished" ON "outbox"  ("created_at") WHERE "published_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."account_tokens_purpose_enum" AS ENUM('PASSWORD_RESET', 'EMAIL_VERIFY')`,
    );
    await queryRunner.query(
      `CREATE TABLE "account_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "purpose" "public"."account_tokens_purpose_enum" NOT NULL, "token_hash" character(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_167033390a71c52224c7c636c8b" UNIQUE ("token_hash"), CONSTRAINT "PK_5e3640c493cc6206a44b885e6a9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dc3fdc213b9bfc438a86fed443" ON "account_tokens"  ("user_id", "purpose", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "phone" character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "email_verified_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Accounts made before email verification existed count as verified
    // (hand-written: they were never asked, so don't nag them now).
    await queryRunner.query(
      `UPDATE "users" SET "email_verified_at" = "created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_tokens" ADD CONSTRAINT "FK_1b5fea09efc20c7f63c4a09b3d6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_tokens" DROP CONSTRAINT "FK_1b5fea09efc20c7f63c4a09b3d6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "email_verified_at"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "phone"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_dc3fdc213b9bfc438a86fed443"`,
    );
    await queryRunner.query(`DROP TABLE "account_tokens"`);
    await queryRunner.query(`DROP TYPE "public"."account_tokens_purpose_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
  }
}
