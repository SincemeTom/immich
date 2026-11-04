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

/** A photo of another user, which a photo they added to a Synology album may be */
export type SynologyUserAsset = SynologyLibraryAsset & {
  originalFileName: string;
  libraryId: string | null;
  localDateTime: Date;
};

/** the photos that may be in albums: not the video part of a live photo, nor in the locked folder */
const visible = [AssetVisibility.Timeline, AssetVisibility.Archive];

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
      .where('asset.visibility', 'in', visible)
      .stream();
  }

  /** All the photos of a user, wherever they are, but those in the trash, the locked folder, and live photos' videos */
  @GenerateSql({ params: [DummyValue.UUID] })
  getUserAssets(ownerId: string): AsyncIterableIterator<SynologyUserAsset> {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('library', 'library.id', 'asset.libraryId')
      .select([
        'asset.id',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.isOffline',
        'asset.localDateTime',
        'asset.libraryId',
        'asset_exif.fileSizeInByte',
      ])
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', visible)
      .where((eb) => eb.or([eb('asset.libraryId', 'is', null), eb('library.deletedAt', 'is', null)]))
      .stream();
  }

  /** The users who logged in with an OAuth ID among these, whatever its case */
  @GenerateSql({ params: [['alice']] })
  getUsersByOAuthIds(oauthIds: string[]) {
    if (oauthIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('user')
      .select(['id', 'oauthId'])
      .where('deletedAt', 'is', null)
      .where(sql<boolean>`lower("oauthId") = any(${oauthIds.map((id) => id.toLowerCase())}::text[])`)
      .$narrowType<{ oauthId: string }>()
      .execute();
  }

  /** The owners of photos */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getAssetOwners(assetIds: string[]): Promise<Map<string, string>> {
    if (assetIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom('asset')
      .select(['id', 'ownerId'])
      .where(sql<boolean>`"id" = any(${assetIds}::uuid[])`)
      .execute();
    return new Map(rows.map(({ id, ownerId }) => [id, ownerId]));
  }

  /** The members the sync shared an album with, and Synology's role for each when last synced */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getMembers(albumId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom('synology_album_user')
      .select(['userId', 'role'])
      .where('albumId', '=', albumId)
      .execute();
    return new Map(rows.map(({ userId, role }) => [userId, role]));
  }

  async setMember(albumId: string, userId: string, role: string) {
    await this.db
      .insertInto('synology_album_user')
      .values({ albumId, userId, role })
      .onConflict((oc) => oc.columns(['albumId', 'userId']).doUpdateSet({ role }))
      .execute();
  }

  async removeMember(albumId: string, userId: string) {
    await this.db
      .deleteFrom('synology_album_user')
      .where('albumId', '=', albumId)
      .where('userId', '=', userId)
      .execute();
  }
}
