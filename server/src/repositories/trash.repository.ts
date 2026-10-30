import { InjectKysely } from 'nestjs-kysely';
import type { Kysely } from 'kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

export class TrashRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getDeletedIds(): AsyncIterableIterator<{ id: string }> {
    return this.db.selectFrom('asset').select(['id']).where('status', '=', AssetStatus.Deleted).stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async restore(userId: string): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  /**
   * The external libraries with files of this user that went offline: a scan put them in the trash, but as active
   * assets, which empty() leaves, as a library whose share isn't mounted has every file offline
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getOfflineLibraryIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select('libraryId')
      .distinct()
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Active)
      .where('isOffline', '=', true)
      .where('deletedAt', 'is not', null)
      .where('libraryId', 'is not', null)
      .execute();

    return rows.map(({ libraryId }) => libraryId!);
  }

  /** Empties the offline files of these libraries from the trash, as empty() does the rest */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async emptyOffline(userId: string, libraryIds: string[]): Promise<number> {
    if (libraryIds.length === 0) {
      return 0;
    }

    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Active)
      .where('isOffline', '=', true)
      .where('deletedAt', 'is not', null)
      .where('libraryId', 'in', libraryIds)
      .set({ status: AssetStatus.Deleted })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async empty(userId: string): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      .set({ status: AssetStatus.Deleted })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async restoreAll(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('status', '=', AssetStatus.Trashed)
      .where('id', 'in', ids)
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }
}
