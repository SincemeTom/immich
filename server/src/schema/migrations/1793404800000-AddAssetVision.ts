import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_vision" (
  "assetId" uuid NOT NULL,
  "version" smallint NOT NULL,
  "aestheticScore" real,
  "isUtility" boolean,
  "isScreenshot" boolean NOT NULL DEFAULT false,
  "labels" jsonb NOT NULL,
  "barcodes" text[] NOT NULL,
  "analyzedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_vision_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_vision_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_vision";`.execute(db);
}
