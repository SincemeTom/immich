import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" ADD "autoStackedAt" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "stack" ADD "isAutomatic" boolean NOT NULL DEFAULT false;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "autoStackedAt";`.execute(db);
  await sql`ALTER TABLE "stack" DROP COLUMN "isAutomatic";`.execute(db);
}
