import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "synology_album" (
  "albumId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "source" character varying NOT NULL,
  "synologyAlbumId" integer NOT NULL,
  "name" character varying NOT NULL,
  "thumbnailItemId" integer,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "syncedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "synology_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "synology_album_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "synology_album_userId_source_synologyAlbumId_uq" UNIQUE ("userId", "source", "synologyAlbumId"),
  CONSTRAINT "synology_album_pkey" PRIMARY KEY ("albumId")
);`.execute(db);
  await sql`CREATE INDEX "synology_album_userId_idx" ON "synology_album" ("userId");`.execute(db);
  await sql`CREATE TABLE "synology_album_asset" (
  "albumId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  CONSTRAINT "synology_album_asset_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "synology_album" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "synology_album_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "synology_album_asset_pkey" PRIMARY KEY ("albumId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "synology_album_asset_albumId_idx" ON "synology_album_asset" ("albumId");`.execute(db);
  await sql`CREATE INDEX "synology_album_asset_assetId_idx" ON "synology_album_asset" ("assetId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "synology_album_asset";`.execute(db);
  await sql`DROP TABLE "synology_album";`.execute(db);
}
