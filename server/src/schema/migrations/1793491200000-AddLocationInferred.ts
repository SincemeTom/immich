import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_exif" ADD "locationInferred" boolean;`.execute(db);
  await sql`CREATE INDEX "asset_localDateTime_range_idx" ON "asset" ("localDateTime");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_localDateTime_range_idx";`.execute(db);
  await sql`ALTER TABLE "asset_exif" DROP COLUMN "locationInferred";`.execute(db);
}
