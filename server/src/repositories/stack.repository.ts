import { Injectable } from '@nestjs/common';
import { type ExpressionBuilder, type Insertable, type Kysely, type Updateable, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { Chunked, DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { StackTable } from 'src/schema/tables/stack.table.js';
import { anyUuid, asUuid, withDefaultVisibility } from 'src/utils/database.js';

export interface StackSearch {
  ownerId: string;
  primaryAssetId?: string;
}

export interface AutoStackCandidateSearch {
  ownerId: string;
  assetId: string;
  /** the camera's burst id */
  autoStackId?: string | null;
  /** lowercased names without extension, from getAutoStackNameKeys */
  nameKeys: string[];
  /** taken in this window, with their CLIP distance to this embedding */
  similar?: { from: Date; to: Date; embedding: string };
}

const escapeLike = (value: string) => value.replaceAll(/[\\%_]/g, (match) => `\\${match}`);

const autoStackColumns = [
  'asset.id',
  'asset.ownerId',
  'asset.type',
  'asset.originalFileName',
  'asset.originalPath',
  'asset.fileCreatedAt',
  'asset.isFavorite',
  'asset.width',
  'asset.height',
  'asset.stackId',
  'asset_exif.dateTimeOriginal',
  'asset_exif.model',
  'asset_exif.rating',
  'asset_exif.autoStackId',
  'asset_job_status.autoStackedAt',
] as const;

const withAssets = (eb: ExpressionBuilder<DB, 'stack'>, withTags = false) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .selectAll('asset')
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_exif')
            .select(columns.exif)
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('exifInfo'),
        (join) => join.onTrue(),
      )
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(columns.tag)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo'))
      .where('asset.deletedAt', 'is', null)
      .whereRef('asset.stackId', '=', 'stack.id')
      .$call(withDefaultVisibility)
      .orderBy('asset.fileCreatedAt', 'asc'),
  ).as('assets');
};

@Injectable()
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID }] })
  search(query: StackSearch) {
    return this.db
      .selectFrom('stack')
      .selectAll('stack')
      .select(withAssets)
      .where('stack.ownerId', '=', query.ownerId)
      .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
      .execute();
  }

  async create(entity: Omit<Insertable<StackTable>, 'primaryAssetId'>, assetIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      const stacks = await tx
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds)
        .select('stack.id')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.stackId', '=', 'stack.id')
              .where('asset.deletedAt', 'is', null),
          ).as('assets'),
        )
        .execute();

      const uniqueIds = new Set<string>(assetIds);

      // children
      for (const stack of stacks) {
        if (stack.assets && stack.assets.length > 0) {
          for (const asset of stack.assets) {
            uniqueIds.add(asset.id);
          }
        }
      }

      if (stacks.length > 0) {
        await tx
          .deleteFrom('stack')
          .where(
            'id',
            'in',
            stacks.map((stack) => stack.id),
          )
          .execute();
      }

      const newRecord = await tx
        .insertInto('stack')
        .values({ ...entity, primaryAssetId: assetIds[0] })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('asset')
        .set({
          stackId: newRecord.id,
          updatedAt: new Date(),
        })
        .where('id', 'in', [...uniqueIds])
        .execute();

      return tx
        .selectFrom('stack')
        .selectAll('stack')
        .select(withAssets)
        .where('id', '=', newRecord.id)
        .executeTakeFirstOrThrow();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', asUuid(id)).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.db.deleteFrom('stack').where('id', 'in', ids).execute();
  }

  update(id: string, entity: Updateable<StackTable>) {
    return this.db
      .updateTable('stack')
      .set(entity)
      .where('id', '=', asUuid(id))
      .returningAll('stack')
      .returning((eb) => withAssets(eb, true))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string) {
    return this.db
      .selectFrom('stack')
      .selectAll()
      .select((eb) => withAssets(eb, true))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  /** An asset as auto stacking looks at it */
  @GenerateSql({ params: [DummyValue.UUID] })
  getForAutoStack(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .leftJoin('smart_search', 'smart_search.assetId', 'asset.id')
      .select(autoStackColumns)
      .select(['asset.visibility', 'asset.deletedAt', 'smart_search.embedding'])
      .where('asset.id', '=', asUuid(id))
      .executeTakeFirst();
  }

  /**
   * The owner's assets that may belong in a stack with an asset: of the same burst, with a matching name, or taken
   * within seconds of it. Each rule decides on them afterwards; this only narrows them down, along indexes.
   */
  @GenerateSql({
    params: [
      {
        ownerId: DummyValue.UUID,
        assetId: DummyValue.UUID,
        autoStackId: 'burst',
        nameKeys: ['img_1234', 'img_e1234'],
        similar: { from: DummyValue.DATE, to: DummyValue.DATE, embedding: DummyValue.VECTOR },
      },
    ],
  })
  getAutoStackCandidates({ ownerId, assetId, autoStackId, nameKeys, similar }: AutoStackCandidateSearch) {
    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .leftJoin('smart_search', 'smart_search.assetId', 'asset.id')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(autoStackColumns)
      .select(['stack.isAutomatic', 'stack.primaryAssetId'])
      .select(
        similar
          ? sql<number | null>`smart_search.embedding <=> ${similar.embedding}`.as('distance')
          : sql<number | null>`null::real`.as('distance'),
      )
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset.id', '!=', asUuid(assetId))
      .where('asset.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          ...(autoStackId ? [eb('asset_exif.autoStackId', '=', autoStackId)] : []),
          // along the trigram index of file names
          ...nameKeys.map((key) =>
            eb(sql`f_unaccent(asset."originalFileName")`, 'ilike', sql`f_unaccent(${`${escapeLike(key)}.%`})`),
          ),
          ...(similar ? [eb.between('asset.fileCreatedAt', similar.from, similar.to)] : []),
          eb.val(false),
        ]),
      )
      .orderBy('asset.fileCreatedAt')
      .limit(500)
      .execute();
  }

  /** Assets of these owners auto stacking has yet to look at: not in a stack, and never taken out of one it made */
  @GenerateSql({ params: [[DummyValue.UUID], false], stream: true })
  streamForAutoStack(ownerIds: string[], force: boolean) {
    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .select(['asset.id'])
      .where('asset.ownerId', '=', anyUuid(ownerIds))
      .where('asset.deletedAt', 'is', null)
      .where('asset.stackId', 'is', null)
      .$if(!force, (qb) => qb.where('asset_job_status.autoStackedAt', 'is', null))
      .orderBy('asset.fileCreatedAt')
      .stream();
  }

  /** Puts assets in a stack, as auto stacking adds them to one */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  async addAssets(stackId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await this.db
      .updateTable('asset')
      .set({ stackId, updatedAt: new Date() })
      .where('id', '=', anyUuid(assetIds))
      .where('stackId', 'is', null)
      .execute();
  }

  /** Forgets which of an owner's assets were taken out of a stack auto stacking made, so it looks at them again */
  @GenerateSql({ params: [DummyValue.UUID] })
  async resetAutoStacked(ownerId: string): Promise<void> {
    await this.db
      .updateTable('asset_job_status')
      .set({ autoStackedAt: null })
      .from('asset')
      .whereRef('asset.id', '=', 'asset_job_status.assetId')
      .where('asset.ownerId', '=', asUuid(ownerId))
      .where('asset.stackId', 'is', null)
      .execute();
  }

  /** Removes the stacks auto stacking made for an owner, leaving their assets for it to look at again */
  @GenerateSql({ params: [DummyValue.UUID] })
  removeAutomatic(ownerId: string) {
    return this.db.transaction().execute(async (tx) => {
      const stacks = await tx
        .selectFrom('stack')
        .select('id')
        .where('ownerId', '=', asUuid(ownerId))
        .where('isAutomatic', '=', true)
        .execute();
      const ids = stacks.map(({ id }) => id);
      if (ids.length === 0) {
        return 0;
      }

      await tx
        .updateTable('asset_job_status')
        .set({ autoStackedAt: null })
        .from('asset')
        .whereRef('asset.id', '=', 'asset_job_status.assetId')
        .where('asset.stackId', '=', anyUuid(ids))
        .execute();
      await tx.deleteFrom('stack').where('id', '=', anyUuid(ids)).execute();
      return ids.length;
    });
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  merge({ sourceId, targetId }: { sourceId: string; targetId: string }) {
    return this.db.updateTable('asset').set({ stackId: targetId }).where('asset.stackId', '=', sourceId).execute();
  }
}
