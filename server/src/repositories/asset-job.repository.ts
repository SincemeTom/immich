import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  anyUuid,
  asUuid,
  withAudioStream,
  withDefaultVisibility,
  withEdits,
  withExif,
  withExifInner,
  withFaces,
  withFilePath,
  withFiles,
  withVideoFormat,
  withVideoStream,
} from 'src/utils/database.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/** a list of task names as a text[] literal (they are the server's own constants) */
const taskArray = (values: string[]) => sql`array[${sql.join(values.map((value) => sql.lit(value)))}]::text[]`;

@Injectable()
export class AssetJobRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSearchDuplicatesJob(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .leftJoin('smart_search', 'asset.id', 'smart_search.assetId')
      .select(['id', 'type', 'ownerId', 'duplicateId', 'stackId', 'visibility', 'smart_search.embedding'])
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSidecarWriteJob(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .select(['id', 'originalPath'])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .$call(withExifInner)
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSidecarCheckJob(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .select(['id', 'originalPath'])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .limit(1)
      .executeTakeFirst();
  }

  /** Raw photos, whose previews depend on whether the camera's embedded JPEG is used */
  @GenerateSql({ params: [], stream: true })
  streamRawImages() {
    const extensions = sql.join(Object.keys(mimeTypes.raw).map((extension) => sql.lit(`%${extension}`)));
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.type', '=', AssetType.Image)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where(sql`lower(asset."originalFileName")`, 'like', sql`any(array[${extensions}]::text[])`)
      .stream();
  }

  @GenerateSql({ params: [{ force: false, fullsizeEnabled: true }], stream: true })
  streamForThumbnailJob(options: { force: boolean | undefined; fullsizeEnabled: boolean }) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.isEdited'])
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden))
      .$if(!options.force, (qb) =>
        qb
          // If there aren't any entries, metadata extraction hasn't run yet which is required for thumbnails
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where(({ and, eb, exists, not, or, selectFrom }) => {
            const file = (type: AssetFileType) =>
              selectFrom('asset_file').whereRef('assetId', '=', 'asset.id').where('type', '=', sql.lit(type));

            const conditions = [
              not(exists(file(AssetFileType.Thumbnail))),
              not(exists(file(AssetFileType.Preview))),
              and([
                eb('asset.isEdited', '=', sql.lit(true)),
                not(exists(file(AssetFileType.FullSize).where('asset_file.isEdited', '=', sql.lit(true)))),
              ]),
              eb('asset.thumbhash', 'is', null),
            ];

            if (options.fullsizeEnabled) {
              const isWebUnsupported = sql.join(
                Object.keys(mimeTypes.webUnsupportedImage).map((ext) => sql.lit(`%${ext}`)),
              );
              conditions.push(
                and([
                  not(exists(file(AssetFileType.FullSize))),
                  eb(sql`f_unaccent(asset."originalFileName")`, 'like', sql`any(array[${isWebUnsupported}]::text[])`),
                ]),
              );
            }

            return or(conditions);
          }),
      )
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForMigrationJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .select(withFiles)
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForGenerateThumbnailJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.visibility',
        'asset.originalFileName',
        'asset.originalPath',
        'asset.ownerId',
        'asset.thumbhash',
        'asset.type',
        'asset.livePhotoVideoId',
      ])
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset_file')
            .select(columns.assetFilesForThumbnail)
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', 'in', [AssetFileType.Thumbnail, AssetFileType.Preview, AssetFileType.FullSize]),
        ).as('files'),
      )
      .select(withEdits)
      .$call(withExifInner)
      .leftJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .select((eb) => withVideoStream(eb).as('videoStream'))
      .select((eb) => withVideoFormat(eb).as('format'))
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForMetadataExtraction(id: string) {
    return this.db
      .selectFrom('asset')
      .select(columns.asset)
      .select(withFaces)
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .innerJoin('user', 'user.id', 'asset.ownerId')
      .select(['user.clusterGroupId'])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLockedPropertiesForMetadataExtraction(assetId: string) {
    return this.db
      .selectFrom('asset_exif')
      .select('asset_exif.lockedProperties')
      .where('asset_exif.assetId', '=', assetId)
      .executeTakeFirst()
      .then((row) => row?.lockedProperties ?? []);
  }

  @GenerateSql({ params: [DummyValue.UUID, AssetFileType.Thumbnail] })
  getAlbumThumbnailFiles(id: string, fileType?: AssetFileType) {
    return this.db
      .selectFrom('asset_file')
      .select(columns.assetFiles)
      .where('asset_file.assetId', '=', id)
      .$if(!!fileType, (qb) => qb.where('asset_file.type', '=', fileType!))
      .execute();
  }

  private assetsWithPreviews() {
    return this.db
      .selectFrom('asset')
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where('asset.deletedAt', 'is', null)
      .innerJoin('asset_job_status as job_status', 'assetId', 'asset.id')
      .where((eb) =>
        eb.exists((qb) =>
          qb
            .selectFrom('asset_file')
            .whereRef('assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      );
  }

  @GenerateSql({ params: [], stream: true })
  streamForSearchDuplicates(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.deletedAt', 'is', null)
      .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
      .$call(withDefaultVisibility)
      .$if(!force, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'job_status.assetId', 'asset.id')
          .where('job_status.duplicatesDetectedAt', 'is', null),
      )
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForEncodeClip(force?: boolean) {
    return this.assetsWithPreviews()
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb.where((eb) => eb.not((eb) => eb.exists(eb.selectFrom('smart_search').whereRef('assetId', '=', 'asset.id')))),
      )
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForClipEncoding(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.visibility'])
      .select((eb) => withFiles(eb, AssetFileType.Preview))
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForDetectFacesJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.visibility'])
      .$call(withExifInner)
      .select((eb) => withFaces(eb, true, true))
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset_file')
            .select(columns.assetFiles)
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', sql.lit(AssetFileType.Preview))
            .orderBy('asset_file.isEdited', 'desc')
            .limit(sql.lit(1)),
        ).as('previewFile'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForContentAnalysis(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select((eb) => [
        'asset.id',
        'asset.ownerId',
        'asset.visibility',
        'asset.type',
        'asset.originalFileName',
        'asset.originalPath',
        'asset.duration',
        'asset.width',
        'asset.height',
        'asset.stackId',
        'stack.isAutomatic as stackIsAutomatic',
        'stack.primaryAssetId as stackPrimaryAssetId',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        withFilePath(eb, AssetFileType.Preview).as('previewFile'),
      ])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Those not analyzed yet, by an earlier version, or for fewer requests than this Mac makes now (a photo, imageTasks;
   * a video, videoTasks: after an upgrade to macOS 26, its requests); all of them, with force
   */
  @GenerateSql({ params: [DummyValue.NUMBER, ['classify'], ['classify', 'speech'], false], stream: true })
  streamForContentAnalysis(version: number, imageTasks: string[], videoTasks: string[], force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb
          .leftJoin('asset_vision', 'asset_vision.assetId', 'asset.id')
          .where((eb) =>
            eb.or([
              eb('asset_vision.assetId', 'is', null),
              eb('asset_vision.version', '<', version),
              sql<boolean>`not (asset_vision.features @> case when asset.type = ${AssetType.Video} then ${taskArray(videoTasks)} else ${taskArray(imageTasks)} end)`,
            ]),
          ),
      )
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  isLocationInferred(id: string) {
    return this.db
      .selectFrom('asset_exif')
      .select('asset_exif.locationInferred')
      .where('asset_exif.assetId', '=', id)
      .executeTakeFirst()
      .then((row) => row?.locationInferred === true);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForLocationInference(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.deletedAt',
        'asset.visibility',
        'asset.localDateTime',
        'asset_exif.dateTimeOriginal',
        'asset_exif.latitude',
        'asset_exif.longitude',
        'asset_exif.locationInferred',
        'asset_exif.locationInferredFromId',
      ])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  /**
   * The photo with a location of its own (not an inferred one) taken nearest to `time`, before or after it, within
   * `windowMs`: the user's; with `sharedWith`, also those of others in an album that photo (the user's) is in too. The
   * times are local ones (the clock the photo was taken by): a photo without a location often has no time zone either,
   * and its time taken as UTC would be hours off from those around it with one.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.DATE, 'before', 3_600_000, DummyValue.UUID] })
  getLocationSource(userId: string, time: Date, direction: 'before' | 'after', windowMs: number, sharedWith?: string) {
    const before = direction === 'before';
    return this.db
      .selectFrom('asset_exif')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .select(['asset.id', 'asset_exif.latitude', 'asset_exif.longitude', 'asset.localDateTime'])
      .where('asset.localDateTime', '>=', before ? new Date(time.getTime() - windowMs) : time)
      .where('asset.localDateTime', '<=', before ? time : new Date(time.getTime() + windowMs))
      .where('asset_exif.latitude', 'is not', null)
      .where('asset_exif.longitude', 'is not', null)
      .where(sql<boolean>`asset_exif."locationInferred" is not true`)
      .where('asset.deletedAt', 'is', null)
      .where((eb) =>
        sharedWith
          ? eb.or([
              eb('asset.ownerId', '=', asUuid(userId)),
              eb.exists(
                eb
                  .selectFrom('album_asset as source_album')
                  .innerJoin('album_asset as photo_album', 'photo_album.albumId', 'source_album.albumId')
                  .innerJoin('album', 'album.id', 'source_album.albumId')
                  .innerJoin('album_user', (join) =>
                    join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', asUuid(userId)),
                  )
                  .select(sql`1`.as('found'))
                  .whereRef('source_album.assetId', '=', 'asset.id')
                  .where('photo_album.assetId', '=', asUuid(sharedWith))
                  .where('album.deletedAt', 'is', null),
              ),
            ])
          : eb('asset.ownerId', '=', asUuid(userId)),
      )
      .orderBy('asset.localDateTime', before ? 'desc' : 'asc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * The photos taken within `windowMs` of `time` (local) without a location of their own, that a photo with one (`id`,
   * of `ownerId`) can give one to: its owner's, and those of others in an album it is in too
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.DATE, 3_600_000] })
  getLocationInferenceTargets(id: string, ownerId: string, time: Date, windowMs: number) {
    return this.db
      .selectFrom('asset_exif')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .select(['asset.id'])
      .where('asset.localDateTime', '>=', new Date(time.getTime() - windowMs))
      .where('asset.localDateTime', '<=', new Date(time.getTime() + windowMs))
      .where('asset_exif.dateTimeOriginal', 'is not', null)
      .where((eb) =>
        eb.or([
          eb.and([eb('asset_exif.latitude', 'is', null), eb('asset_exif.locationInferred', 'is', null)]),
          eb('asset_exif.locationInferred', '=', true),
        ]),
      )
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where((eb) =>
        eb.or([
          eb('asset.ownerId', '=', asUuid(ownerId)),
          eb.exists(
            eb
              .selectFrom('album_asset as photo_album')
              .innerJoin('album_asset as source_album', 'source_album.albumId', 'photo_album.albumId')
              .innerJoin('album', 'album.id', 'photo_album.albumId')
              .select(sql`1`.as('found'))
              .whereRef('photo_album.assetId', '=', 'asset.id')
              .where('source_album.assetId', '=', asUuid(id))
              .where('album.deletedAt', 'is', null),
          ),
        ]),
      )
      .execute();
  }

  /** The photos whose locations were inferred from these */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  getInferredFrom(sourceIds: string[]) {
    return this.db
      .selectFrom('asset_exif')
      .select(['asset_exif.assetId as id'])
      .where('asset_exif.locationInferred', '=', true)
      .where('asset_exif.locationInferredFromId', '=', anyUuid(sourceIds))
      .execute();
  }

  /** What the inferred location of a photo was taken from: when the photo was taken, and whose it is */
  @GenerateSql({ params: [DummyValue.UUID] })
  getLocationInferenceSource(id: string) {
    return this.db
      .selectFrom('asset_exif')
      .innerJoin('asset as source', 'source.id', 'asset_exif.locationInferredFromId')
      .innerJoin('user', 'user.id', 'source.ownerId')
      .select(['source.id', 'source.localDateTime', 'source.ownerId', 'user.name as ownerName'])
      .where('asset_exif.assetId', '=', asUuid(id))
      .where('asset_exif.locationInferred', '=', true)
      .executeTakeFirst();
  }

  /** Those without a location (and not one cleared by their owner); with force, also those with an inferred one */
  @GenerateSql({ params: [false], stream: true })
  streamForLocationInference(force?: boolean) {
    return this.db
      .selectFrom('asset_exif')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .select(['asset.id'])
      .where('asset_exif.dateTimeOriginal', 'is not', null)
      .where((eb) => {
        const missing = eb.and([eb('asset_exif.latitude', 'is', null), eb('asset_exif.locationInferred', 'is', null)]);
        return force ? eb.or([missing, eb('asset_exif.locationInferred', '=', true)]) : missing;
      })
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }

  /** Unless the photo has a location of its own by now, or its owner cleared the one inferred */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      { latitude: 31.2, longitude: 121.5, city: null, state: null, country: null, sourceId: DummyValue.UUID },
    ],
  })
  async setInferredLocation(
    id: string,
    {
      sourceId,
      ...location
    }: {
      latitude: number;
      longitude: number;
      city: string | null;
      state: string | null;
      country: string | null;
      sourceId: string;
    },
  ) {
    const result = await this.db
      .updateTable('asset_exif')
      .set({ ...location, locationInferred: true, locationInferredFromId: sourceId })
      .where('assetId', '=', id)
      .where((eb) =>
        eb.or([
          eb.and([eb('latitude', 'is', null), eb('locationInferred', 'is', null)]),
          eb('locationInferred', '=', true),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Takes away inferred locations: of one photo, or all of them. As its owner clears one (`rejected`), it is not
   * inferred again; otherwise it can be.
   */
  @GenerateSql({ params: [DummyValue.UUID, true] })
  async clearInferredLocations(id: string | undefined, rejected: boolean) {
    const result = await this.db
      .updateTable('asset_exif')
      .set({
        latitude: null,
        longitude: null,
        city: null,
        state: null,
        country: null,
        locationInferred: rejected ? false : null,
        locationInferredFromId: null,
      })
      .where('locationInferred', '=', true)
      .$if(id !== undefined, (qb) => qb.where('assetId', '=', id!))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForOcr(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) => ['asset.visibility', withFilePath(eb, AssetFileType.Preview).as('previewFile')])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForSyncAssets(ids: string[]) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.isOffline',
        'asset.libraryId',
        'asset.originalPath',
        'asset.status',
        'asset.deletedAt',
        'asset.fileModifiedAt',
        'asset.checksum',
        'asset.checksumAlgorithm',
      ])
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForFileChecksum(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.libraryId',
        'asset.originalPath',
        'asset.checksum',
        'asset.checksumAlgorithm',
        'asset.isOffline',
        'asset.visibility',
        'asset.duplicateId',
        'asset.type',
        'asset.livePhotoVideoId',
      ])
      .leftJoin('asset as motion', 'motion.id', 'asset.livePhotoVideoId')
      .select('motion.libraryId as livePhotoVideoLibraryId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select('asset_exif.livePhotoCID')
      .where('asset.id', '=', id)
      .where('asset.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForAssetDeletion(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.visibility',
        'asset.libraryId',
        'asset.ownerId',
        'asset.livePhotoVideoId',
        'asset.originalPath',
        'asset.isOffline',
      ])
      .$call(withExif)
      .select(withFiles)
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('stack')
            .whereRef('stack.id', '=', 'asset.stackId')
            .select((eb) => [
              'stack.id',
              'stack.primaryAssetId',
              jsonArrayFrom(
                eb
                  .selectFrom('asset as stack_asset')
                  .select(['stack_asset.id'])
                  .whereRef('stack_asset.stackId', '=', 'stack.id')
                  .whereRef('stack_asset.id', '!=', 'stack.primaryAssetId')
                  .where('stack_asset.visibility', '=', sql.val(AssetVisibility.Timeline))
                  .where('stack_asset.status', '!=', sql.val(AssetStatus.Deleted)),
              ).as('assets'),
            ])
            .as('stack_result'),
        (join) => join.onTrue(),
      )
      .select((eb) =>
        eb.fn
          .toJson(eb.table('stack_result'))
          .$castTo<{ id: string; primaryAssetId: string; assets: { id: string }[] } | null>()
          .as('stack'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForVideoConversion(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_file')
                .select('asset_file.id')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', sql.lit(AssetFileType.EncodedVideo)),
            ),
          ),
        ),
      )
      .where('asset.deletedAt', 'is', null)
      .stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForVideoConversion(id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .innerJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .leftJoin('asset_audio', 'asset_audio.assetId', 'asset.id')
      .select(['asset.id', 'asset.ownerId', 'asset.originalPath'])
      .select(withFiles)
      .select((eb) => withAudioStream(eb).as('audioStream'))
      .select((eb) => withVideoStream(eb).$notNull().as('videoStream'))
      .select((eb) => withVideoFormat(eb).$notNull().as('format'))
      .where('asset.id', '=', id)
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForMetadataExtraction(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb
          .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where((eb) =>
            eb.or([eb('asset_job_status.metadataExtractedAt', 'is', null), eb('asset_job_status.assetId', 'is', null)]),
          ),
      )
      .where('asset.deletedAt', 'is', null)
      .stream();
  }

  private storageTemplateAssetQuery() {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.checksum',
        'asset.originalPath',
        'asset.isExternal',
        'asset.visibility',
        'asset.originalFileName',
        'asset.livePhotoVideoId',
        'asset.fileCreatedAt',
        'asset_exif.timeZone',
        'asset_exif.fileSizeInByte',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.lensModel',
      ])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .where('asset.deletedAt', 'is', null);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForStorageTemplateJob(id: string, options?: { includeHidden?: boolean }) {
    return this.storageTemplateAssetQuery()
      .where('asset.id', '=', id)
      .$if(!options?.includeHidden, (qb) => qb.where('asset.visibility', '!=', AssetVisibility.Hidden))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForStorageTemplateJob() {
    return this.storageTemplateAssetQuery().where('asset.visibility', '!=', AssetVisibility.Hidden).stream();
  }

  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamForDeletedJob(trashedBefore: Date) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'isOffline', 'libraryId'])
      .where('asset.deletedAt', '<=', trashedBefore)
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForSidecar(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_file')
                .select('asset_file.id')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', AssetFileType.Sidecar),
            ),
          ),
        ),
      )
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForDetectFacesJob(force?: boolean) {
    return this.assetsWithPreviews()
      .$if(force === false, (qb) => qb.where('job_status.facesRecognizedAt', 'is', null))
      .select(['asset.id'])
      .orderBy('asset.fileCreatedAt', 'desc')
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForOcrJob(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where('asset_job_status.ocrAt', 'is', null),
      )
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }

  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamForMigrationJob() {
    return this.db.selectFrom('asset').select(['id']).where('asset.deletedAt', 'is', null).stream();
  }
}
