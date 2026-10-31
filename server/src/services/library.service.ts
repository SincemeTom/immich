import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { R_OK } from 'node:constants';
import { Stats } from 'node:fs';
import path, { isAbsolute, parse } from 'node:path';
import picomatch from 'picomatch';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  CreateLibraryDto,
  LibraryResponseDto,
  LibraryStatsResponseDto,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryImportPathResponseDto,
  ValidateLibraryResponseDto,
  mapLibrary,
} from 'src/dtos/library.dto.js';
import {
  AssetStatus,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  CronJob,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
} from 'src/enum.js';
import { AssetSyncResult } from 'src/repositories/library.repository.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { isAssetLibraryChecksumConstraint } from 'src/utils/database.js';
import { createImmichFolderCheck, isLibraryReachable, isWithinImportPath } from 'src/utils/library.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, findOrFail, handlePromiseError } from 'src/utils/misc.js';
import { isWithin } from 'src/utils/storage-location.js';

@Injectable()
export class LibraryService extends BaseService {
  private watchLibraries = false;
  private lock = false;
  private watchers: Record<string, () => Promise<void>> = {};

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      library: { watch, scan },
    },
  }: ArgOf<'ConfigInit'>) {
    // This ensures that library watching only occurs in one microservice
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.Library);

    this.watchLibraries = this.lock && watch.enabled;

    if (this.lock) {
      this.cronRepository.create({
        name: CronJob.LibraryScan,
        expression: scan.cronExpression,
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.LibraryScanQueueAll }), this.logger),
        start: scan.enabled,
      });
      // a library deleted while its job was lost (a queue emptied, a restart) is cleaned up now, not at midnight
      await this.jobRepository.queue({ name: JobName.LibraryDeleteCheck, data: {} });
    }

    if (this.watchLibraries) {
      await this.watchAll();
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  async onConfigUpdate({ newConfig: { library } }: ArgOf<'ConfigUpdate'>) {
    if (!this.lock) {
      return;
    }

    this.cronRepository.update({
      name: CronJob.LibraryScan,
      expression: library.scan.cronExpression,
      start: library.scan.enabled,
    });

    if (library.watch.enabled === this.watchLibraries) {
      return;
    }

    // Watch configuration changed, update accordingly
    this.watchLibraries = library.watch.enabled;
    await (this.watchLibraries ? this.watchAll() : this.unwatchAll());
  }

  private async watch(id: string): Promise<boolean> {
    if (!this.watchLibraries) {
      return false;
    }

    const library = await this.findOrFail(id);
    if (library.importPaths.length === 0) {
      return false;
    }

    await this.unwatch(id);

    this.logger.log(`Starting to watch library ${library.id} with import path(s) ${library.importPaths}`);

    const matcher = picomatch(`**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`, {
      nocase: true,
      ignore: library.exclusionPatterns,
    });

    let _resolve: () => void;
    const ready$ = new Promise<void>((resolve) => (_resolve = resolve));

    const handler = async (event: string, path: string) => {
      // a folder Immich keeps its own files in, inside an import path: a user's originals on the NAS, say
      const isImmichFolder = createImmichFolderCheck(this.storageRepository, library.importPaths);
      if (matcher(path) && !StorageCore.isInStorageLocation(path) && !(await isImmichFolder(path))) {
        this.logger.debug(`File ${event} event received for ${path} in library ${library.id}`);
        await this.jobRepository.queue({
          name: JobName.LibrarySyncFiles,
          data: { libraryId: library.id, paths: [path] },
        });
      } else {
        this.logger.verbose(`Ignoring file ${event} event for ${path} in library ${library.id}`);
      }
    };

    const deletionHandler = async (path: string) => {
      this.logger.debug(`File unlink event received for ${path} in library ${library.id}`);
      await this.jobRepository.queue({
        name: JobName.LibraryRemoveAsset,
        data: { libraryId: library.id, paths: [path] },
      });
    };

    this.watchers[id] = this.storageRepository.watch(
      library.importPaths,
      {
        usePolling: false,
        ignoreInitial: true,
        ignored: library.exclusionPatterns,
        awaitWriteFinish: {
          stabilityThreshold: 5000,
          pollInterval: 1000,
        },
      },
      {
        onReady: () => _resolve(),
        onAdd: (path) => {
          return handlePromiseError(handler('add', path), this.logger);
        },
        onChange: (path) => {
          return handlePromiseError(handler('change', path), this.logger);
        },
        onUnlink: (path) => {
          return handlePromiseError(deletionHandler(path), this.logger);
        },
        onError: (error) => {
          this.logger.error(`Library watcher for library ${library.id} encountered error: ${error}`);
        },
      },
    );

    // Wait for the watcher to initialize before returning
    await ready$;

    return true;
  }

  async unwatch(id: string) {
    if (!Object.hasOwn(this.watchers, id)) {
      return;
    }

    await this.watchers[id]();
    delete this.watchers[id];
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    await this.unwatchAll();
  }

  private async unwatchAll() {
    if (!this.lock) {
      return false;
    }

    for (const id in this.watchers) {
      await this.unwatch(id);
    }
  }

  async watchAll() {
    if (!this.lock) {
      return false;
    }

    const libraries = await this.libraryRepository.getAll(false);
    for (const library of libraries) {
      await this.watch(library.id);
    }
  }

  async getStatistics(id: string): Promise<LibraryStatsResponseDto> {
    const statistics = await this.libraryRepository.getStatistics(id);
    if (!statistics) {
      throw new BadRequestException(`Library ${id} not found`);
    }
    return statistics;
  }

  async get(id: string): Promise<LibraryResponseDto> {
    const library = await this.findOrFail(id);
    return mapLibrary(library);
  }

  async getAll(): Promise<LibraryResponseDto[]> {
    const libraries = await this.libraryRepository.getAll(false);
    return libraries.map((library) => mapLibrary(library));
  }

  @OnJob({ name: JobName.LibraryDeleteCheck, queue: QueueName.Library })
  async handleQueueCleanup(): Promise<JobStatus> {
    this.logger.log('Checking for any libraries pending deletion...');
    const pendingDeletions = await this.libraryRepository.getAllDeleted();
    if (pendingDeletions.length > 0) {
      const libraryString = pendingDeletions.length === 1 ? 'library' : 'libraries';
      this.logger.log(`Found ${pendingDeletions.length} ${libraryString} pending deletion, cleaning up...`);

      await this.jobRepository.queueAll(
        pendingDeletions.map((libraryToDelete) => ({ name: JobName.LibraryDelete, data: { id: libraryToDelete.id } })),
      );
    }

    return JobStatus.Success;
  }

  async create(dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    const library = await this.libraryRepository.create({
      ownerId: dto.ownerId,
      name: dto.name ?? 'New External Library',
      importPaths: dto.importPaths ?? [],
      exclusionPatterns: dto.exclusionPatterns ?? [
        '**/@eaDir/**',
        '**/._*',
        '**/#recycle/**',
        '**/#snapshot/**',
        '**/.stversions/**',
        '**/.stfolder/**',
      ],
    });
    return mapLibrary(library);
  }

  @OnJob({ name: JobName.LibrarySyncFiles, queue: QueueName.Library })
  async handleSyncFiles(job: JobOf<JobName.LibrarySyncFiles>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.libraryId);
    // We need to check if the library still exists as it could have been deleted after the scan was queued
    if (!library) {
      this.logger.debug(`Library ${job.libraryId} not found, skipping file import`);
      return JobStatus.Failed;
    }
    if (library.deletedAt) {
      this.logger.debug(`Library ${job.libraryId} is deleted, won't import assets into it`);
      return JobStatus.Failed;
    }

    const assetImports: Insertable<AssetTable>[] = [];
    await Promise.all(
      job.paths.map(async (path) => {
        try {
          const asset = await this.processEntity(path, library.ownerId, job.libraryId);
          assetImports.push(asset);
        } catch (error) {
          this.logger.error(`Error processing ${path} for library ${job.libraryId}: ${error}`);
        }
      }),
    );

    const assetIds = await this.assetRepository.createAll(assetImports);

    const progressMessage =
      job.progressCounter && job.totalAssets
        ? `(${job.progressCounter} of ${job.totalAssets})`
        : `(${job.progressCounter} done so far)`;

    this.logger.log(`Imported ${assetIds.length} ${progressMessage} file(s) into library ${job.libraryId}`);

    await Promise.all(
      assetIds.map((assetId) =>
        this.eventRepository.emit('AssetCreate', { asset: { id: assetId, ownerId: library.ownerId } }),
      ),
    );

    await this.queuePostSyncJobs(assetIds);

    return JobStatus.Success;
  }

  private async validateImportPath(
    importPath: string,
    ownerId?: string,
  ): Promise<ValidateLibraryImportPathResponseDto> {
    const validation = new ValidateLibraryImportPathResponseDto();
    validation.importPath = importPath;
    validation.isValid = false;

    if (StorageCore.isImmichPath(importPath)) {
      validation.message = 'Cannot use media upload folder for external libraries';
      return validation;
    }

    // a folder holding another user's own: their home on the NAS, say, which would be imported as this user's
    const resolved = path.resolve(importPath);
    const otherUsers = Object.entries(StorageCore.getStorageLocations().users).filter(([userId]) => userId !== ownerId);
    if (otherUsers.some(([, folder]) => isWithin(folder, resolved))) {
      validation.message = "Holds another user's storage location: import only from folders of the library's owner";
      return validation;
    }

    if (!isAbsolute(importPath)) {
      validation.message = `Import path must be absolute, try ${path.resolve(importPath)}`;
      return validation;
    }

    try {
      const stat = await this.storageRepository.stat(importPath);
      if (!stat.isDirectory()) {
        validation.message = 'Not a directory';
        return validation;
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        validation.message = 'Path does not exist (ENOENT)';
        return validation;
      }
      validation.message = String(error);
      return validation;
    }

    const isAccess = await this.storageRepository.checkFileExists(importPath, R_OK);

    if (!isAccess) {
      validation.message = 'Lacking read permission for folder';
      return validation;
    }

    validation.isValid = true;
    return validation;
  }

  async validate(id: string, dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    const library = await this.libraryRepository.get(id);
    const importPaths = await Promise.all(
      (dto.importPaths || []).map((importPath) => this.validateImportPath(importPath, library?.ownerId)),
    );
    return { importPaths };
  }

  async update(id: string, dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    await this.findOrFail(id);

    if (dto.importPaths) {
      const validation = await this.validate(id, { importPaths: dto.importPaths });
      if (validation.importPaths) {
        for (const path of validation.importPaths) {
          if (!path.isValid) {
            throw new BadRequestException(`Invalid import path: ${path.message}`);
          }
        }
      }
    }

    const library = await this.libraryRepository.update(id, dto);
    return mapLibrary(library);
  }

  async delete(id: string) {
    await this.findOrFail(id);

    if (this.watchLibraries) {
      await this.unwatch(id);
    }

    await this.libraryRepository.softDelete(id);
    // Its assets go at once, from the timeline, albums, shared links and the trash alike: what the job does next is
    // to clean them up, and it may run late, or be lost from an emptied queue (LibraryDeleteCheck queues it again)
    await this.hideLibraryAssets(id);
    await this.jobRepository.queue({ name: JobName.LibraryDelete, data: { id } });
  }

  private async hideLibraryAssets(libraryId: string) {
    await this.assetRepository.updateByLibraryId(libraryId, { deletedAt: new Date(), status: AssetStatus.Deleted });
  }

  @OnJob({ name: JobName.LibraryDelete, queue: QueueName.Library })
  async handleDeleteLibrary(job: JobOf<JobName.LibraryDelete>): Promise<JobStatus> {
    const libraryId = job.id;

    // again, for a library deleted before they were hidden at once
    await this.hideLibraryAssets(libraryId);

    this.logger.debug(`Will delete all assets in library ${libraryId}`);
    let hasAssets = false;
    for await (const assets of batched(
      this.libraryRepository.streamAssetIds(libraryId),
      JOBS_LIBRARY_PAGINATION_SIZE,
    )) {
      this.logger.debug(`Queueing deletion of ${assets.length} asset(s) in library ${libraryId}`);
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetDelete, data: { id: asset.id, deleteOnDisk: false } })),
      );
      hasAssets = true;
    }

    if (!hasAssets) {
      this.logger.log(`Deleting library ${libraryId}`);
      await this.libraryRepository.delete(libraryId);
    }

    return JobStatus.Success;
  }

  private async processEntity(filePath: string, ownerId: string, libraryId: string) {
    const assetPath = path.normalize(filePath);
    const stat = await this.storageRepository.stat(assetPath);

    return {
      ownerId,
      libraryId,
      checksum: this.cryptoRepository.hashSha1(`path:${assetPath}`),
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      originalPath: assetPath,

      fileCreatedAt: stat.mtime,
      fileModifiedAt: stat.mtime,
      localDateTime: stat.mtime,
      type: mimeTypes.isVideo(assetPath) ? AssetType.Video : AssetType.Image,
      originalFileName: parse(assetPath).base,
      isExternal: true,
      livePhotoVideoId: null,
    };
  }

  async queuePostSyncJobs(assetIds: string[]) {
    this.logger.debug(`Queuing sidecar discovery for ${assetIds.length} asset(s)`);

    // We queue a sidecar discovery which, in turn, queues metadata extraction
    await this.jobRepository.queueAll(
      assetIds.map((assetId) => ({
        name: JobName.SidecarCheck,
        data: { id: assetId, source: 'upload' },
      })),
    );

    // new and changed files are hashed by their contents, which uploads are checked against
    await this.queueFileChecksums(assetIds);
  }

  private async queueFileChecksums(assetIds: string[]) {
    await this.jobRepository.queueAll(
      assetIds.map((assetId) => ({ name: JobName.LibraryAssetChecksum, data: { id: assetId } })),
    );
  }

  /** Files imported with the path hash, before contents were hashed, which every scan works through */
  private hasPathChecksum(asset: { checksum: Buffer; checksumAlgorithm: ChecksumAlgorithm; originalPath: string }) {
    return (
      asset.checksumAlgorithm === ChecksumAlgorithm.sha1Path &&
      asset.checksum.equals(this.cryptoRepository.hashSha1(`path:${asset.originalPath}`))
    );
  }

  /**
   * Hashes an external file's contents, as uploads are, so that a phone's backup recognises the photos the library
   * already has, and so that a copy uploaded before shows up next to it in the duplicates utility.
   */
  @OnJob({ name: JobName.LibraryAssetChecksum, queue: QueueName.Library })
  async handleAssetChecksum({ id }: JobOf<JobName.LibraryAssetChecksum>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForFileChecksum(id);
    if (!asset?.libraryId || asset.isOffline) {
      return JobStatus.Skipped;
    }

    let checksum: Buffer;
    try {
      checksum = await this.cryptoRepository.hashFile(asset.originalPath);
    } catch (error) {
      this.logger.warn(`Could not read ${asset.originalPath} to hash its contents: ${error}`);
      return JobStatus.Failed;
    }

    await this.relinkLivePhoto(asset);

    if (asset.checksumAlgorithm === ChecksumAlgorithm.sha1File && checksum.equals(asset.checksum)) {
      return JobStatus.Skipped;
    }

    try {
      await this.assetRepository.update({ id, checksum, checksumAlgorithm: ChecksumAlgorithm.sha1File });
    } catch (error) {
      if (!isAssetLibraryChecksumConstraint(error)) {
        throw error;
      }

      // Checksums are unique per library, so a second file with the same contents keeps a hash of its path. It is
      // not the path hash scans look for, so they don't hash it again; the first file stands for both in backups.
      this.logger.log(`${asset.originalPath} has the same contents as another file in library ${asset.libraryId}`);
      await this.assetRepository.update({
        id,
        checksum: this.cryptoRepository.hashSha1(`same-contents:${asset.originalPath}`),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      });
      return JobStatus.Success;
    }

    if (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive) {
      await this.groupUploadedCopies({ ...asset, checksum });
    }

    return JobStatus.Success;
  }

  /**
   * Before a still was paired with the video in its own library, one in an external library whose photos were also
   * backed up from the phone could be paired with the uploaded video, and the upload's still with the library's.
   * Then removing the uploads deleted the library still's video. This pairs it with its library's video again.
   */
  private async relinkLivePhoto(asset: {
    id: string;
    ownerId: string;
    libraryId: string | null;
    type: AssetType;
    livePhotoVideoId: string | null;
    livePhotoVideoLibraryId: string | null;
    livePhotoCID: string | null;
  }) {
    if (
      asset.type !== AssetType.Image ||
      !asset.livePhotoVideoId ||
      !asset.livePhotoCID ||
      asset.livePhotoVideoLibraryId === asset.libraryId
    ) {
      return;
    }

    const match = await this.assetRepository.findLivePhotoMatch({
      ownerId: asset.ownerId,
      libraryId: asset.libraryId,
      livePhotoCID: asset.livePhotoCID,
      otherAssetId: asset.id,
      type: AssetType.Video,
    });
    if (!match || match.libraryId !== asset.libraryId) {
      return;
    }

    await this.assetRepository.swapLivePhotoVideo(asset.id, match.id, asset.livePhotoVideoId);
    this.logger.log(`Paired live photo ${asset.id} with the video ${match.id} in its own library`);
  }

  /** Puts uploads with the same contents in one duplicate group with the file, which the utility suggests keeping */
  private async groupUploadedCopies(asset: {
    id: string;
    ownerId: string;
    checksum: Buffer;
    duplicateId: string | null;
  }) {
    const copies = await this.assetRepository.getUploadedCopies(asset.ownerId, asset.checksum);
    if (copies.length === 0) {
      return;
    }

    const duplicateIds = [
      ...new Set([asset.duplicateId, ...copies.map((copy) => copy.duplicateId)].filter((id): id is string => !!id)),
    ];
    const targetId = duplicateIds.shift() ?? this.cryptoRepository.randomUUID();
    await this.duplicateRepository.merge({
      targetId,
      assetIds: [asset.id, ...copies.map((copy) => copy.id)],
      sourceIds: duplicateIds,
    });
    this.logger.log(`${copies.length} upload(s) have the same contents as external asset ${asset.id}`);
  }

  async queueScan(id: string) {
    await this.findOrFail(id);

    this.logger.log(`Starting to scan library ${id}`);

    await this.jobRepository.queue({
      name: JobName.LibrarySyncFilesQueueAll,
      data: {
        id,
      },
    });

    await this.jobRepository.queue({ name: JobName.LibrarySyncAssetsQueueAll, data: { id } });
  }

  @OnJob({ name: JobName.LibraryScanQueueAll, queue: QueueName.Library })
  async handleQueueScanAll(): Promise<JobStatus> {
    this.logger.log(`Initiating scan of all external libraries...`);

    await this.jobRepository.queue({ name: JobName.LibraryDeleteCheck, data: {} });

    const libraries = await this.libraryRepository.getAll(true);

    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LibrarySyncFilesQueueAll,
        data: {
          id: library.id,
        },
      })),
    );
    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LibrarySyncAssetsQueueAll,
        data: {
          id: library.id,
        },
      })),
    );

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibrarySyncAssets, queue: QueueName.Library })
  async handleSyncAssets(job: JobOf<JobName.LibrarySyncAssets>): Promise<JobStatus> {
    const assets = await this.assetJobRepository.getForSyncAssets(job.assetIds);

    const assetIdsToOffline: string[] = [];
    const trashedAssetIdsToOffline: string[] = [];
    const assetIdsToOnline: string[] = [];
    const trashedAssetIdsToOnline: string[] = [];
    const assetIdsToUpdate: string[] = [];
    const assetIdsToChecksum: string[] = [];

    this.logger.debug(`Checking batch of ${assets.length} existing asset(s) in library ${job.libraryId}`);

    const stats = await Promise.all(
      assets.map((asset) => this.storageRepository.stat(asset.originalPath).catch(() => null)),
    );

    // A file missing from an import path that can't be reached (a NAS share that isn't mounted: an empty folder)
    // may well still be there, and stays as it is until the path is back
    const unreachable: string[] = [];
    for (const importPath of job.importPaths) {
      if (!(await isLibraryReachable(this.storageRepository, [importPath]))) {
        unreachable.push(importPath);
      }
    }
    let kept = 0;

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const stat = stats[i];
      let action = this.checkExistingAsset(asset, stat);
      if (
        action === AssetSyncResult.OFFLINE &&
        !stat &&
        unreachable.some((importPath) => isWithinImportPath(asset.originalPath, importPath))
      ) {
        action = AssetSyncResult.DO_NOTHING;
        kept++;
      }
      switch (action) {
        case AssetSyncResult.DO_NOTHING: {
          if (stat && this.hasPathChecksum(asset)) {
            assetIdsToChecksum.push(asset.id);
          }
          break;
        }
        case AssetSyncResult.OFFLINE: {
          if (asset.status === AssetStatus.Trashed) {
            trashedAssetIdsToOffline.push(asset.id);
          } else {
            assetIdsToOffline.push(asset.id);
          }
          break;
        }
        case AssetSyncResult.UPDATE: {
          assetIdsToUpdate.push(asset.id);
          break;
        }
        case AssetSyncResult.CHECK_OFFLINE: {
          const isInImportPath = job.importPaths.some((path) => asset.originalPath.startsWith(path));

          if (!isInImportPath) {
            this.logger.verbose(
              `Offline asset ${asset.originalPath} is still not in any import path, keeping offline in library ${job.libraryId}`,
            );
            break;
          }

          const isExcluded =
            StorageCore.isInStorageLocation(asset.originalPath) ||
            job.exclusionPatterns.some((pattern) => picomatch.isMatch(asset.originalPath, pattern, { nocase: true }));

          if (!isExcluded) {
            this.logger.debug(`Offline asset ${asset.originalPath} is now online in library ${job.libraryId}`);
            if (asset.status === AssetStatus.Trashed) {
              trashedAssetIdsToOnline.push(asset.id);
            } else {
              assetIdsToOnline.push(asset.id);
            }
            break;
          }

          this.logger.verbose(
            `Offline asset ${asset.originalPath} is in an import path but still covered by exclusion pattern, keeping offline in library ${job.libraryId}`,
          );

          break;
        }
      }
    }

    if (kept > 0) {
      this.logger.warn(
        `Kept ${kept} missing asset(s) of library ${job.libraryId} as they are, as their import path cannot be reached: ${unreachable.join(', ')}`,
      );
    }

    const promises = [];
    if (assetIdsToOffline.length > 0) {
      promises.push(this.assetRepository.updateAll(assetIdsToOffline, { isOffline: true, deletedAt: new Date() }));
    }

    if (trashedAssetIdsToOffline.length > 0) {
      promises.push(this.assetRepository.updateAll(trashedAssetIdsToOffline, { isOffline: true }));
    }

    if (assetIdsToOnline.length > 0) {
      promises.push(this.assetRepository.updateAll(assetIdsToOnline, { isOffline: false, deletedAt: null }));
    }

    if (trashedAssetIdsToOnline.length > 0) {
      promises.push(this.assetRepository.updateAll(trashedAssetIdsToOnline, { isOffline: false }));
    }

    if (assetIdsToUpdate.length > 0) {
      promises.push(this.queuePostSyncJobs(assetIdsToUpdate));
    }

    if (assetIdsToChecksum.length > 0) {
      promises.push(this.queueFileChecksums(assetIdsToChecksum));
    }

    await Promise.all(promises);

    const remainingCount = assets.length - assetIdsToOffline.length - assetIdsToUpdate.length - assetIdsToOnline.length;
    const cumulativePercentage = ((100 * job.progressCounter) / job.totalAssets).toFixed(1);
    this.logger.log(
      `Checked existing asset(s): ${assetIdsToOffline.length + trashedAssetIdsToOffline.length} offlined, ${assetIdsToOnline.length + trashedAssetIdsToOnline.length} onlined, ${assetIdsToUpdate.length} updated, ${remainingCount} unchanged of current batch of ${assets.length}${assetIdsToChecksum.length > 0 ? `, ${assetIdsToChecksum.length} queued for hashing their contents` : ''} (Total progress: ${job.progressCounter} of ${job.totalAssets}, ${cumulativePercentage} %) in library ${job.libraryId}.`,
    );

    return JobStatus.Success;
  }

  private checkExistingAsset(
    asset: {
      isOffline: boolean;
      libraryId: string | null;
      originalPath: string;
      status: AssetStatus;
      deletedAt: Date | null;
      fileModifiedAt: Date;
    },
    stat: Stats | null,
  ): AssetSyncResult {
    if (!stat) {
      // File not found on disk or permission error. Offline already, and in the trash, or trashed by the user; but
      // one marked offline while its share was unmounted on purpose, and missing once it is back, goes to the trash
      if (asset.isOffline && (asset.deletedAt || asset.status !== AssetStatus.Active)) {
        this.logger.verbose(
          `Asset ${asset.originalPath} is still not accessible, keeping offline in library ${asset.libraryId}`,
        );
        return AssetSyncResult.DO_NOTHING;
      }

      this.logger.debug(
        `Asset ${asset.originalPath} is no longer on disk or is inaccessible because of permissions, marking offline in library ${asset.libraryId}`,
      );
      return AssetSyncResult.OFFLINE;
    }

    if (asset.isOffline && asset.status !== AssetStatus.Deleted) {
      // Only perform the expensive check if the asset is offline
      return AssetSyncResult.CHECK_OFFLINE;
    }

    if (stat.mtime.valueOf() !== asset.fileModifiedAt.valueOf()) {
      this.logger.verbose(`Asset ${asset.originalPath} needs metadata extraction in library ${asset.libraryId}`);

      return AssetSyncResult.UPDATE;
    }

    return AssetSyncResult.DO_NOTHING;
  }

  @OnJob({ name: JobName.LibrarySyncFilesQueueAll, queue: QueueName.Library })
  async handleQueueSyncFiles(job: JobOf<JobName.LibrarySyncFilesQueueAll>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      this.logger.debug(`Library ${job.id} not found, skipping refresh`);
      return JobStatus.Skipped;
    }

    this.logger.debug(`Validating import paths for library ${library.id}...`);

    const validImportPaths: string[] = [];

    for (const importPath of library.importPaths) {
      const validation = await this.validateImportPath(importPath, library.ownerId);
      if (validation.isValid) {
        validImportPaths.push(path.normalize(importPath));
      } else {
        this.logger.warn(`Skipping invalid import path: ${importPath}. Reason: ${validation.message}`);
      }
    }

    if (validImportPaths.length === 0) {
      this.logger.warn(`No valid import paths found for library ${library.id}`);

      return JobStatus.Skipped;
    }

    const pathsOnDisk = this.storageRepository.walk({
      pathsToCrawl: validImportPaths,
      includeHidden: false,
      exclusionPatterns: library.exclusionPatterns,
      take: JOBS_LIBRARY_PAGINATION_SIZE,
    });

    let importCount = 0;
    let crawlCount = 0;
    const isImmichFolder = createImmichFolderCheck(this.storageRepository, validImportPaths);

    this.logger.log(`Starting disk crawl of ${validImportPaths.length} import path(s) for library ${library.id}...`);

    for await (const crawled of pathsOnDisk) {
      // a folder Immich keeps its own files in, inside an import path: a user's originals on the NAS, say
      const kept = crawled.filter((path) => !StorageCore.isInStorageLocation(path));
      const marked = await Promise.all(kept.map((path) => isImmichFolder(path)));
      const pathBatch = kept.filter((_, i) => !marked[i]);
      crawlCount += pathBatch.length;
      const paths = await this.assetRepository.filterNewExternalAssetPaths(library.id, pathBatch);

      if (paths.length > 0) {
        importCount += paths.length;

        await this.jobRepository.queue({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths,
            progressCounter: crawlCount,
          },
        });
      }

      this.logger.log(
        `Crawled ${crawlCount} file(s) so far: ${paths.length} of current batch of ${pathBatch.length} will be imported to library ${library.id}...`,
      );
    }

    this.logger.log(
      `Finished disk crawl, ${crawlCount} file(s) found on disk and queued ${importCount} file(s) for import into ${library.id}`,
    );

    await this.libraryRepository.update(job.id, { refreshedAt: new Date() });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibraryRemoveAsset, queue: QueueName.Library })
  async handleAssetRemoval(job: JobOf<JobName.LibraryRemoveAsset>): Promise<JobStatus> {
    // This is only for handling file unlink events via the file watcher
    this.logger.verbose(`Deleting asset(s) ${job.paths} from library ${job.libraryId}`);
    for (const assetPath of job.paths) {
      const asset = await this.assetRepository.getByLibraryIdAndOriginalPath(job.libraryId, assetPath);
      if (asset) {
        await this.assetRepository.remove(asset);
      }
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibrarySyncAssetsQueueAll, queue: QueueName.Library })
  async handleQueueSyncAssets(job: JobOf<JobName.LibrarySyncAssetsQueueAll>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      return JobStatus.Skipped;
    }

    const assetCount = await this.assetRepository.getLibraryAssetCount(job.id);
    if (!assetCount) {
      this.logger.log(`Library ${library.id} is empty, no need to check assets`);
      return JobStatus.Success;
    }

    this.logger.log(
      `Checking ${assetCount} asset(s) against import paths and exclusion patterns in library ${library.id}...`,
    );

    const offlineResult = await this.assetRepository.detectOfflineExternalAssets(
      library.id,
      library.importPaths,
      library.exclusionPatterns,
    );

    const affectedAssetCount = Number(offlineResult.numUpdatedRows);

    this.logger.log(
      `${affectedAssetCount} asset(s) out of ${assetCount} were offlined due to import paths and/or exclusion pattern(s) in library ${library.id}`,
    );

    if (affectedAssetCount === assetCount) {
      return JobStatus.Success;
    }

    this.logger.log(`Scanning library ${library.id} for assets missing from disk...`);

    let count = 0;
    const existingAssets = this.libraryRepository.streamAssetIds(library.id);
    for await (const assets of batched(existingAssets, JOBS_LIBRARY_PAGINATION_SIZE)) {
      count += assets.length;

      await this.jobRepository.queue({
        name: JobName.LibrarySyncAssets,
        data: {
          libraryId: library.id,
          importPaths: library.importPaths,
          exclusionPatterns: library.exclusionPatterns,
          assetIds: assets.map(({ id }) => id),
          progressCounter: count,
          totalAssets: assetCount,
        },
      });

      const completePercentage = ((100 * count) / assetCount).toFixed(1);

      this.logger.log(
        `Queued check of ${count} of ${assetCount} (${completePercentage} %) existing asset(s) so far in library ${library.id}`,
      );
    }

    this.logger.log(`Finished queuing ${count} asset check(s) for library ${library.id}`);

    return JobStatus.Success;
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.libraryRepository.get(id), 'Library');
  }
}
