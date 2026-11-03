import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album_user" ADD "allowDownload" boolean NOT NULL DEFAULT false;`.execute(db);
  await sql`ALTER TABLE "album_user" ADD "isManager" boolean NOT NULL DEFAULT false;`.execute(db);
  // existing members keep what they could do: everyone downloads, editors manage the album
  await sql`UPDATE "album_user" SET "allowDownload" = true, "isManager" = ("role" = 'editor');`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album_user" DROP COLUMN "isManager";`.execute(db);
  await sql`ALTER TABLE "album_user" DROP COLUMN "allowDownload";`.execute(db);
}
