import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_vision" (
  "assetId" uuid NOT NULL,
  "version" smallint NOT NULL,
  "features" text[] NOT NULL,
  "aestheticScore" real,
  "isUtility" boolean,
  "isScreenshot" boolean NOT NULL DEFAULT false,
  "labels" jsonb NOT NULL,
  "barcodes" text[] NOT NULL,
  "isDocument" boolean,
  "smudge" real,
  "transcript" text,
  "transcriptSegments" jsonb,
  "transcriptLanguage" text,
  "analyzedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_vision_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_vision_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE INDEX "idx_asset_vision_transcript" ON "asset_vision" USING gin (f_unaccent("transcript") gin_trgm_ops);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_idx_asset_vision_transcript', '{"type":"index","name":"idx_asset_vision_transcript","sql":"CREATE INDEX \\"idx_asset_vision_transcript\\" ON \\"asset_vision\\" USING gin (f_unaccent(\\"transcript\\") gin_trgm_ops);"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_idx_asset_vision_transcript';`.execute(db);
  await sql`DROP TABLE "asset_vision";`.execute(db);
}
