import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { SynologyAlbumTable } from 'src/schema/tables/synology-album.table.js';
import { asUuid, dummy } from 'src/utils/database.js';

/** A photo of the user's own external libraries, which a Synology album's photo may be */
export type SynologyLibraryAsset = {
  id: string;
  originalPath: string;
  isOffline: boolean;
  fileSizeInByte: number | null;
};

/** What the Synology album sync keeps: the albums it created, and the photos it added to them */
@Injectable()
export class SynologyAlbumRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getAll(userId: string) {
    return this.db.selectFrom('synology_album').selectAll().where('userId', '=', userId).execute();
  }

  async create(values: Insertable<SynologyAlbumTable>) {
    await this.db.insertInto('synology_album').values(values).execute();
  }

  async update(albumId: string, values: Updateable<SynologyAlbumTable>) {
    await this.db.updateTable('synology_album').set(values).where('albumId', '=', albumId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getAssetIds(albumId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('synology_album_asset')
      .select('assetId')
      .where('albumId', '=', albumId)
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  async addAssetIds(albumId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('synology_album_asset')
      .columns(['albumId', 'assetId'])
      .expression((eb) =>
        eb
          .selectFrom(dummy)
          .select([asUuid(albumId).as('albumId'), sql<string>`unnest(${assetIds}::uuid[])`.as('assetId')]),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async removeAssetIds(albumId: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('synology_album_asset')
      .where('albumId', '=', albumId)
      .where(sql<boolean>`"assetId" = any(${assetIds}::uuid[])`)
      .execute();
  }

  /** All the photos in an album, whoever added them */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getAlbumAssetIds(albumId: string): Promise<Set<string>> {
    const rows = await this.db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  /**
   * The photos of the user's own external libraries, which the Synology Photos folders are mounted in: those not in
   * the trash, and not the video part of a live photo
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getLibraryAssets(ownerId: string): AsyncIterableIterator<SynologyLibraryAsset> {
    return this.db
      .selectFrom('asset')
      .innerJoin('library', 'library.id', 'asset.libraryId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset.originalPath', 'asset.isOffline', 'asset_exif.fileSizeInByte'])
      .where('library.ownerId', '=', ownerId)
      .where('library.deletedAt', 'is', null)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }
}
