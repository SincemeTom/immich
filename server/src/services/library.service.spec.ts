import { BadRequestException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { vitest } from 'vitest';
import type { ILibraryBulkIdsJob, ILibraryFileJob } from 'src/types.js';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { mapLibrary } from 'src/dtos/library.dto.js';
import { AssetType, AssetVisibility, ChecksumAlgorithm, CronJob, ImmichWorker, JobName, JobStatus } from 'src/enum.js';
import { LibraryService } from 'src/services/library.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { makeMockWatcher } from 'test/repositories/storage.repository.mock.js';
import { factory, newDate, newUuid } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

async function* mockWalk() {
  // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject
  yield await Promise.resolve(['/data/user1/photo.jpg']);
}

const syncJob = (importPaths: string[], assetIds: string[]): ILibraryBulkIdsJob => ({
  assetIds,
  libraryId: 'library-id',
  importPaths,
  exclusionPatterns: [],
  totalAssets: assetIds.length,
  progressCounter: 0,
});

const syncAssetsJob = (assetIds: string[]): ILibraryBulkIdsJob => ({
  assetIds,
  libraryId: 'library-id',
  importPaths: ['/'],
  exclusionPatterns: [],
  totalAssets: assetIds.length,
  progressCounter: assetIds.length,
});

describe(LibraryService.name, () => {
  let sut: LibraryService;

  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LibraryService));

    mocks.database.tryLock.mockResolvedValue(true);
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onConfigInit', () => {
    it('should init cron job and handle config changes', async () => {
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });

      expect(mocks.cron.create).toHaveBeenCalled();

      await sut.onConfigUpdate({
        oldConfig: defaults,
        newConfig: {
          library: {
            scan: {
              enabled: true,
              cronExpression: '0 1 * * *',
            },
            watch: { enabled: false },
          },
        } as SystemConfig,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: '0 1 * * *',
        start: true,
      });
    });

    it('should initialize watcher for all external libraries', async () => {
      const library1 = factory.library({ importPaths: ['/foo', '/bar'] });
      const library2 = factory.library({ importPaths: ['/xyz', '/asdf'] });

      mocks.library.getAll.mockResolvedValue([library1, library2]);

      mocks.library.get.mockImplementation((id) =>
        Promise.resolve([library1, library2].find((library) => library.id === id)),
      );
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.storage.watch.mock.calls).toEqual(
        expect.arrayContaining([(library1.importPaths, expect.anything()), (library2.importPaths, expect.anything())]),
      );
    });

    it('should not initialize watcher when watching is disabled', async () => {
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchDisabled as SystemConfig });

      expect(mocks.storage.watch).not.toHaveBeenCalled();
    });

    it('should not initialize watcher when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.storage.watch).not.toHaveBeenCalled();
    });

    it('should not initialize library scan cron job when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });

      expect(mocks.cron.create).not.toHaveBeenCalled();
    });
  });

  describe('onConfigUpdateEvent', () => {
    beforeEach(async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });
    });

    it('should do nothing if instance does not have the watch lock', async () => {
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: defaults });
      await sut.onConfigUpdate({ newConfig: systemConfigStub.libraryScan as SystemConfig, oldConfig: defaults });
      expect(mocks.cron.update).not.toHaveBeenCalled();
    });

    it('should update cron job and enable watching', async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScanAndWatch as SystemConfig,
        oldConfig: defaults,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: systemConfigStub.libraryScan.library.scan.cronExpression,
        start: systemConfigStub.libraryScan.library.scan.enabled,
      });
    });

    it('should update cron job and disable watching', async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();
      mocks.cron.update.mockResolvedValue();

      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScanAndWatch as SystemConfig,
        oldConfig: defaults,
      });
      await sut.onConfigUpdate({
        newConfig: systemConfigStub.libraryScan as SystemConfig,
        oldConfig: defaults,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({
        name: CronJob.LibraryScan,
        expression: systemConfigStub.libraryScan.library.scan.cronExpression,
        start: systemConfigStub.libraryScan.library.scan.enabled,
      });
    });
  });

  describe('handleQueueSyncFiles', () => {
    it('should leave out the folders Immich keeps its own files in', async () => {
      const library = factory.library({ importPaths: ['/nas/me/Photos'] });
      StorageCore.setStorageLocations({ folders: {}, users: { 'user-id': '/nas/me/Photos/Immich' }, pending: {} });
      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(async function* () {
        await Promise.resolve();
        yield ['/nas/me/Photos/2024/a.jpg', '/nas/me/Photos/Immich/2026/10/b.jpg', '/nas/me/Photos/Immich2/c.jpg'];
      });
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.asset.filterNewExternalAssetPaths.mockImplementation((_, paths) => Promise.resolve(paths));

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.asset.filterNewExternalAssetPaths).toHaveBeenCalledWith(library.id, [
        '/nas/me/Photos/2024/a.jpg',
        '/nas/me/Photos/Immich2/c.jpg',
      ]);
    });

    it('should queue refresh of a new asset', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(mockWalk);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.asset.filterNewExternalAssetPaths.mockResolvedValue(['/data/user1/photo.jpg']);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncFiles,
        data: {
          libraryId: library.id,
          paths: ['/data/user1/photo.jpg'],
          progressCounter: 1,
        },
      });
    });

    it('should fail when library is not found', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      await expect(sut.handleQueueSyncFiles({ id: library.id })).resolves.toBe(JobStatus.Skipped);
    });

    it('should ignore import paths that do not exist', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });
      mocks.storage.stat.mockImplementation((path): Promise<Stats> => {
        if (path === library.importPaths[0]) {
          const error = { code: 'ENOENT' } as any;
          throw error;
        }
        return Promise.resolve({
          isDirectory: () => true,
        } as Stats);
      });

      mocks.storage.checkFileExists.mockResolvedValue(true);

      mocks.library.get.mockResolvedValue(library);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.storage.walk).toHaveBeenCalledWith({
        pathsToCrawl: [library.importPaths[1]],
        exclusionPatterns: [],
        includeHidden: false,
        take: JOBS_LIBRARY_PAGINATION_SIZE,
      });
    });
  });

  describe('handleQueueSyncFiles', () => {
    it('should queue refresh of a new asset', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(mockWalk);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.asset.filterNewExternalAssetPaths.mockResolvedValue(['/data/user1/photo.jpg']);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncFiles,
        data: {
          libraryId: library.id,
          paths: ['/data/user1/photo.jpg'],
          progressCounter: 1,
        },
      });
    });

    it("should fail when library can't be found", async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      await expect(sut.handleQueueSyncFiles({ id: library.id })).resolves.toBe(JobStatus.Skipped);
    });

    it('should ignore import paths that do not exist', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.storage.stat.mockImplementation((path): Promise<Stats> => {
        if (path === library.importPaths[0]) {
          const error = { code: 'ENOENT' } as any;
          throw error;
        }
        return Promise.resolve({
          isDirectory: () => true,
        } as Stats);
      });

      mocks.storage.checkFileExists.mockResolvedValue(true);

      mocks.library.get.mockResolvedValue(library);

      await sut.handleQueueSyncFiles({ id: library.id });

      expect(mocks.storage.walk).toHaveBeenCalledWith({
        pathsToCrawl: [library.importPaths[1]],
        exclusionPatterns: [],
        includeHidden: false,
        take: JOBS_LIBRARY_PAGINATION_SIZE,
      });
    });
  });

  describe('handleQueueSyncAssets', () => {
    it('should call the offline check', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(async function* generator() {});
      mocks.asset.getLibraryAssetCount.mockResolvedValue(1);
      mocks.asset.detectOfflineExternalAssets.mockResolvedValue({ numUpdatedRows: 1n });

      const response = await sut.handleQueueSyncAssets({ id: library.id });

      expect(response).toBe(JobStatus.Success);
      expect(mocks.asset.detectOfflineExternalAssets).toHaveBeenCalledWith(
        library.id,
        library.importPaths,
        library.exclusionPatterns,
      );
    });

    it('should skip an empty library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(async function* generator() {});
      mocks.asset.getLibraryAssetCount.mockResolvedValue(0);
      mocks.asset.detectOfflineExternalAssets.mockResolvedValue({ numUpdatedRows: 1n });

      const response = await sut.handleQueueSyncAssets({ id: library.id });

      expect(response).toBe(JobStatus.Success);
      expect(mocks.asset.detectOfflineExternalAssets).not.toHaveBeenCalled();
    });

    it('should queue asset sync', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });
      const asset = AssetFactory.create({ libraryId: library.id, isExternal: true });

      mocks.library.get.mockResolvedValue(library);
      mocks.storage.walk.mockImplementation(async function* generator() {});
      mocks.library.streamAssetIds.mockReturnValue(makeStream([asset]));
      mocks.asset.getLibraryAssetCount.mockResolvedValue(1);
      mocks.asset.detectOfflineExternalAssets.mockResolvedValue({ numUpdatedRows: 0n });

      const response = await sut.handleQueueSyncAssets({ id: library.id });

      expect(mocks.job.queue).toBeCalledWith({
        name: JobName.LibrarySyncAssets,
        data: {
          libraryId: library.id,
          importPaths: library.importPaths,
          exclusionPatterns: library.exclusionPatterns,
          assetIds: [asset.id],
          progressCounter: 1,
          totalAssets: 1,
        },
      });

      expect(response).toBe(JobStatus.Success);
      expect(mocks.asset.detectOfflineExternalAssets).toHaveBeenCalledWith(
        library.id,
        library.importPaths,
        library.exclusionPatterns,
      );
    });

    it("should fail if library can't be found", async () => {
      await expect(sut.handleQueueSyncAssets({ id: newUuid() })).resolves.toBe(JobStatus.Skipped);
    });
  });

  describe('handleSyncAssets', () => {
    it('should queue hashing the contents of files imported with a path hash', async () => {
      const mtime = new Date('2023-01-01');
      const pathHashed = AssetFactory.create({
        libraryId: 'library-id',
        isExternal: true,
        originalPath: '/photos/a.jpg',
        fileModifiedAt: mtime,
        checksum: Buffer.from('path:/photos/a.jpg (hashed)'),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      });
      const contentHashed = AssetFactory.create({
        libraryId: 'library-id',
        isExternal: true,
        originalPath: '/photos/b.jpg',
        fileModifiedAt: mtime,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
      });
      const sameContents = AssetFactory.create({
        libraryId: 'library-id',
        isExternal: true,
        originalPath: '/photos/c.jpg',
        fileModifiedAt: mtime,
        checksum: Buffer.from('same-contents:/photos/c.jpg (hashed)'),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      });
      mocks.assetJob.getForSyncAssets.mockResolvedValue([pathHashed, contentHashed, sameContents]);
      mocks.storage.stat.mockResolvedValue({ mtime } as Stats);

      await expect(
        sut.handleSyncAssets(syncAssetsJob([pathHashed.id, contentHashed.id, sameContents.id])),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledTimes(1);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.LibraryAssetChecksum, data: { id: pathHashed.id } },
      ]);
    });

    it('should queue hashing a changed file again, with its metadata extraction', async () => {
      const asset = AssetFactory.create({
        libraryId: 'library-id',
        isExternal: true,
        fileModifiedAt: new Date('2023-01-01'),
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
      });
      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: new Date('2024-01-01') } as Stats);

      await sut.handleSyncAssets(syncAssetsJob([asset.id]));

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: asset.id, source: 'upload' } },
      ]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LibraryAssetChecksum, data: { id: asset.id } }]);
    });

    it('should offline assets no longer on disk', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      // the import path is there, with other files in it; the asset's file is not
      mocks.storage.stat.mockImplementation((path) =>
        path === '/'
          ? Promise.resolve({ isDirectory: () => true } as Stats)
          : Promise.reject(new Error('ENOENT, no such file or directory')),
      );
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.storage.readdir.mockResolvedValue(['other.jpg']);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], {
        isOffline: true,
        deletedAt: expect.anything(),
      });
    });

    describe('an import path that cannot be reached, as a NAS share that is not mounted', () => {
      beforeEach(() => {
        mocks.storage.checkFileExists.mockResolvedValue(true);
      });

      it.each([
        { name: 'an empty folder', readdir: [] as string[], stat: true },
        { name: 'no folder', readdir: [] as string[], stat: false },
      ])('should keep its missing files as they are when it is $name', async ({ readdir, stat }) => {
        const asset = AssetFactory.create({ libraryId: 'library-id', originalPath: '/mnt/nas/photos/a.jpg' });
        mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
        mocks.storage.stat.mockImplementation((path) =>
          path === '/mnt/nas/photos' && stat
            ? Promise.resolve({ isDirectory: () => true } as Stats)
            : Promise.reject(new Error('ENOENT')),
        );
        mocks.storage.readdir.mockResolvedValue(readdir);

        await expect(sut.handleSyncAssets(syncJob(['/mnt/nas/photos'], [asset.id]))).resolves.toBe(JobStatus.Success);

        expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      });

      it('should still offline the missing files of the import paths that can be reached', async () => {
        const away = AssetFactory.create({ libraryId: 'library-id', originalPath: '/mnt/nas/photos/a.jpg' });
        const gone = AssetFactory.create({ libraryId: 'library-id', originalPath: '/Users/me/Pictures/b.jpg' });
        mocks.assetJob.getForSyncAssets.mockResolvedValue([away, gone]);
        mocks.storage.stat.mockImplementation((path) =>
          path === '/Users/me/Pictures' || path === '/mnt/nas/photos'
            ? Promise.resolve({ isDirectory: () => true } as Stats)
            : Promise.reject(new Error('ENOENT')),
        );
        mocks.storage.readdir.mockImplementation((path) =>
          Promise.resolve(path === '/mnt/nas/photos' ? [] : ['c.jpg']),
        );

        await sut.handleSyncAssets(syncJob(['/mnt/nas/photos', '/Users/me/Pictures'], [away.id, gone.id]));

        expect(mocks.asset.updateAll).toHaveBeenCalledWith([gone.id], {
          isOffline: true,
          deletedAt: expect.anything(),
        });
        expect(mocks.asset.updateAll).not.toHaveBeenCalledWith(expect.arrayContaining([away.id]), expect.anything());
      });

      it('should not take a sibling folder for the import path', async () => {
        const asset = AssetFactory.create({ libraryId: 'library-id', originalPath: '/mnt/nas/photos-old/a.jpg' });
        mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
        mocks.storage.stat.mockImplementation((path) =>
          path === '/mnt/nas/photos-old'
            ? Promise.resolve({ isDirectory: () => true } as Stats)
            : Promise.reject(new Error('ENOENT')),
        );
        mocks.storage.readdir.mockResolvedValue(['b.jpg']);

        await sut.handleSyncAssets(syncJob(['/mnt/nas/photos', '/mnt/nas/photos-old'], [asset.id]));

        expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], {
          isOffline: true,
          deletedAt: expect.anything(),
        });
      });
    });

    it('should set assets deleted from disk as offline', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/data/user2'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockRejectedValue(new Error('Could not read file'));

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], {
        isOffline: true,
        deletedAt: expect.anything(),
      });
    });

    it('should do nothing with offline assets deleted from disk', async () => {
      const asset = AssetFactory.create({ isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/data/user2'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockRejectedValue(new Error('Could not read file'));

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should un-trash an asset previously marked as offline', async () => {
      const asset = AssetFactory.create({ originalPath: '/original/path.jpg', isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/original/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], {
        isOffline: false,
        deletedAt: null,
      });
    });

    it('should do nothing with offline asset if covered by exclusion pattern', async () => {
      const asset = AssetFactory.create({ originalPath: '/original/path.jpg', isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/original/'],
        exclusionPatterns: ['**/path.jpg'],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should do nothing with offline asset if not in import path', async () => {
      const asset = AssetFactory.create({ originalPath: '/original/path.jpg', isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/import/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should do nothing with unchanged online assets', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: asset.fileModifiedAt } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should not touch fileCreatedAt when un-trashing an asset previously marked as offline', async () => {
      const asset = AssetFactory.create({ isOffline: true, deletedAt: newDate() });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime: newDate() } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(
        [asset.id],
        expect.not.objectContaining({
          fileCreatedAt: expect.anything(),
        }),
      );
    });

    it('should update with online assets that have changed', async () => {
      const asset = AssetFactory.create({ libraryId: 'library-id', isExternal: true });
      const mockAssetJob: ILibraryBulkIdsJob = {
        assetIds: [asset.id],
        libraryId: newUuid(),
        importPaths: ['/'],
        exclusionPatterns: [],
        totalAssets: 1,
        progressCounter: 0,
      };

      const mtime = new Date(asset.fileModifiedAt.getDate() + 1);

      mocks.assetJob.getForSyncAssets.mockResolvedValue([asset]);
      mocks.storage.stat.mockResolvedValue({ mtime } as Stats);

      await expect(sut.handleSyncAssets(mockAssetJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.SidecarCheck,
          data: {
            id: asset.id,
            source: 'upload',
          },
        },
      ]);
    });
  });

  describe('handleSyncFiles', () => {
    beforeEach(() => {
      mocks.storage.stat.mockResolvedValue({
        size: 100,
        mtime: new Date('2023-01-01'),
        ctime: new Date('2023-01-01'),
      } as Stats);
    });

    it('should import a new asset', async () => {
      const library = factory.library();
      const asset = AssetFactory.create();

      const mockLibraryJob: ILibraryFileJob = {
        libraryId: library.id,
        paths: ['/data/user1/photo.jpg'],
      };

      mocks.asset.createAll.mockResolvedValue([asset.id]);
      mocks.library.get.mockResolvedValue(library);

      await expect(sut.handleSyncFiles(mockLibraryJob)).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.createAll).toHaveBeenCalledWith([
        expect.objectContaining({
          ownerId: library.ownerId,
          libraryId: library.id,
          originalPath: '/data/user1/photo.jpg',
          type: AssetType.Image,
          originalFileName: 'photo.jpg',
          isExternal: true,
        }),
      ]);

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', {
        asset: { id: asset.id, ownerId: library.ownerId },
      });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.SidecarCheck,
          data: {
            id: asset.id,
            source: 'upload',
          },
        },
      ]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LibraryAssetChecksum, data: { id: asset.id } }]);
    });

    it('should not import an asset to a soft deleted library', async () => {
      const library = factory.library({ deletedAt: new Date() });

      const mockLibraryJob: ILibraryFileJob = {
        libraryId: library.id,
        paths: ['/data/user1/photo.jpg'],
      };

      mocks.library.get.mockResolvedValue(library);

      await expect(sut.handleSyncFiles(mockLibraryJob)).resolves.toBe(JobStatus.Failed);

      expect(mocks.asset.createAll.mock.calls).toEqual([]);
    });
  });

  describe('handleAssetChecksum', () => {
    const contents = Buffer.from('contents');
    const external = {
      id: 'asset-id',
      ownerId: 'user-id',
      libraryId: 'library-id',
      originalPath: '/photos/a.jpg',
      checksum: Buffer.from('path:/photos/a.jpg (hashed)'),
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      isOffline: false,
      visibility: AssetVisibility.Timeline,
      duplicateId: null,
      type: AssetType.Image,
      livePhotoVideoId: null,
      livePhotoVideoLibraryId: null,
      livePhotoCID: null,
    };

    beforeEach(() => {
      mocks.crypto.hashFile.mockResolvedValue(contents);
    });

    describe('a live photo paired with a video outside its library', () => {
      const crossed = {
        ...external,
        livePhotoVideoId: 'uploaded-video',
        livePhotoVideoLibraryId: null,
        livePhotoCID: 'CID',
      };

      it('should pair it with the video in its own library', async () => {
        mocks.assetJob.getForFileChecksum.mockResolvedValue(crossed);
        mocks.asset.findLivePhotoMatch.mockResolvedValue({
          id: 'library-video',
          ownerId: 'user-id',
          libraryId: 'library-id',
        });

        await sut.handleAssetChecksum({ id: external.id });

        expect(mocks.asset.findLivePhotoMatch).toHaveBeenCalledWith({
          ownerId: 'user-id',
          libraryId: 'library-id',
          livePhotoCID: 'CID',
          otherAssetId: external.id,
          type: AssetType.Video,
        });
        expect(mocks.asset.swapLivePhotoVideo).toHaveBeenCalledWith(external.id, 'library-video', 'uploaded-video');
      });

      it('should keep its video when its library has none', async () => {
        mocks.assetJob.getForFileChecksum.mockResolvedValue(crossed);
        mocks.asset.findLivePhotoMatch.mockResolvedValue({ id: 'uploaded-video', ownerId: 'user-id', libraryId: null });

        await sut.handleAssetChecksum({ id: external.id });

        expect(mocks.asset.swapLivePhotoVideo).not.toHaveBeenCalled();
      });

      it('should leave one paired within its library alone', async () => {
        mocks.assetJob.getForFileChecksum.mockResolvedValue({ ...crossed, livePhotoVideoLibraryId: 'library-id' });

        await sut.handleAssetChecksum({ id: external.id });

        expect(mocks.asset.findLivePhotoMatch).not.toHaveBeenCalled();
      });

      it('should pair it even when its contents were hashed already', async () => {
        mocks.assetJob.getForFileChecksum.mockResolvedValue({
          ...crossed,
          checksum: contents,
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
        });
        mocks.asset.findLivePhotoMatch.mockResolvedValue({
          id: 'library-video',
          ownerId: 'user-id',
          libraryId: 'library-id',
        });

        await expect(sut.handleAssetChecksum({ id: external.id })).resolves.toBe(JobStatus.Skipped);

        expect(mocks.asset.swapLivePhotoVideo).toHaveBeenCalledWith(external.id, 'library-video', 'uploaded-video');
      });
    });

    it('should replace the path hash with a hash of the contents', async () => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue(external);

      await expect(sut.handleAssetChecksum({ id: external.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.crypto.hashFile).toHaveBeenCalledWith('/photos/a.jpg');
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: external.id,
        checksum: contents,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
      });
      expect(mocks.asset.getUploadedCopies).toHaveBeenCalledWith('user-id', contents);
      expect(mocks.duplicateRepository.merge).not.toHaveBeenCalled();
    });

    it('should leave an unchanged file alone', async () => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue({
        ...external,
        checksum: contents,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
      });

      await expect(sut.handleAssetChecksum({ id: external.id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'an upload', asset: { ...external, libraryId: null } },
      { name: 'an offline file', asset: { ...external, isOffline: true } },
      { name: 'a missing or trashed asset', asset: undefined },
    ])('should skip $name', async ({ asset }) => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue(asset);

      await expect(sut.handleAssetChecksum({ id: external.id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.crypto.hashFile).not.toHaveBeenCalled();
    });

    it('should fail when the file cannot be read', async () => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue(external);
      mocks.crypto.hashFile.mockRejectedValue(new Error('EIO'));

      await expect(sut.handleAssetChecksum({ id: external.id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('should mark a second file with the same contents, so that scans do not hash it again', async () => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue(external);
      mocks.asset.update.mockRejectedValueOnce({ constraint_name: 'asset_ownerId_libraryId_checksum_idx' });

      await expect(sut.handleAssetChecksum({ id: external.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.update).toHaveBeenLastCalledWith({
        id: external.id,
        checksum: Buffer.from('same-contents:/photos/a.jpg (hashed)'),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      });
      expect(mocks.asset.getUploadedCopies).not.toHaveBeenCalled();
    });

    it('should rethrow other database errors', async () => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue(external);
      mocks.asset.update.mockRejectedValueOnce(new Error('connection lost'));

      await expect(sut.handleAssetChecksum({ id: external.id })).rejects.toThrow('connection lost');
    });

    it('should group uploads with the same contents with the file, reusing a duplicate group', async () => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue(external);
      mocks.asset.getUploadedCopies.mockResolvedValue([
        { id: 'upload-1', duplicateId: null },
        { id: 'upload-2', duplicateId: 'group-1' },
      ]);
      mocks.duplicateRepository.merge.mockResolvedValue();

      await sut.handleAssetChecksum({ id: external.id });

      expect(mocks.duplicateRepository.merge).toHaveBeenCalledWith({
        targetId: 'group-1',
        assetIds: [external.id, 'upload-1', 'upload-2'],
        sourceIds: [],
      });
    });

    it('should not group a hidden file, such as the video of a live photo', async () => {
      mocks.assetJob.getForFileChecksum.mockResolvedValue({ ...external, visibility: AssetVisibility.Hidden });
      mocks.asset.getUploadedCopies.mockResolvedValue([{ id: 'upload-1', duplicateId: null }]);

      await sut.handleAssetChecksum({ id: external.id });

      expect(mocks.asset.update).toHaveBeenCalled();
      expect(mocks.duplicateRepository.merge).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete a library', async () => {
      const library = factory.library();

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);

      await sut.delete(library.id);

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryDelete, data: { id: library.id } });
      expect(mocks.library.softDelete).toHaveBeenCalledWith(library.id);
    });

    it('should allow an external library to be deleted', async () => {
      const library = factory.library();

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);

      await sut.delete(library.id);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibraryDelete,
        data: { id: library.id },
      });

      expect(mocks.library.softDelete).toHaveBeenCalledWith(library.id);
    });

    it('should unwatch an external library when deleted', async () => {
      const library = factory.library({ importPaths: ['/foo', '/bar'] });

      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
      mocks.library.get.mockResolvedValue(library);
      mocks.library.getAll.mockResolvedValue([library]);

      const mockClose = vitest.fn();
      mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      await sut.delete(library.id);

      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return a library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);

      await expect(sut.get(library.id)).resolves.toEqual(
        expect.objectContaining({
          id: library.id,
          name: library.name,
          ownerId: library.ownerId,
        }),
      );

      expect(mocks.library.get).toHaveBeenCalledWith(library.id);
    });

    it('should throw an error when a library is not found', async () => {
      const library = factory.library();

      await expect(sut.get(library.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.library.get).toHaveBeenCalledWith(library.id);
    });
  });

  describe('getStatistics', () => {
    it('should return library statistics', async () => {
      const library = factory.library();

      mocks.library.getStatistics.mockResolvedValue({ photos: 10, videos: 0, total: 10, usage: 1337 });
      await expect(sut.getStatistics(library.id)).resolves.toEqual({
        photos: 10,
        videos: 0,
        total: 10,
        usage: 1337,
      });

      expect(mocks.library.getStatistics).toHaveBeenCalledWith(library.id);
    });
  });

  describe('create', () => {
    describe('external library', () => {
      it('should create with default settings', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(sut.create({ ownerId: authStub.admin.user.id })).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create with name', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);

        await expect(sut.create({ ownerId: authStub.admin.user.id, name: 'My Awesome Library' })).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'My Awesome Library',
            importPaths: [],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create with import paths', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            importPaths: ['/data/images', '/data/videos'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: ['/data/images', '/data/videos'],
            exclusionPatterns: expect.any(Array),
          }),
        );
      });

      it('should create watched with import paths', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.create.mockResolvedValue(library);
        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([]);
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
        await sut.create({ ownerId: authStub.admin.user.id, importPaths: library.importPaths });
      });

      it('should create with exclusion patterns', async () => {
        const library = factory.library();

        mocks.library.create.mockResolvedValue(library);
        await expect(
          sut.create({
            ownerId: authStub.admin.user.id,
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            id: library.id,
            name: library.name,
            ownerId: library.ownerId,
            assetCount: 0,
            importPaths: [],
            exclusionPatterns: [],
            createdAt: library.createdAt,
            updatedAt: library.updatedAt,
            refreshedAt: null,
          }),
        );

        expect(mocks.library.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expect.any(String),
            importPaths: [],
            exclusionPatterns: ['*.tmp', '*.bak'],
          }),
        );
      });
    });
  });

  describe('getAll', () => {
    it('should get all libraries', async () => {
      const library = factory.library();

      mocks.library.getAll.mockResolvedValue([library]);

      await expect(sut.getAll()).resolves.toEqual([expect.objectContaining({ id: library.id })]);
    });
  });

  describe('handleQueueCleanup', () => {
    it('should queue cleanup jobs', async () => {
      const library1 = factory.library({ deletedAt: new Date() });
      const library2 = factory.library({ deletedAt: new Date() });

      mocks.library.getAllDeleted.mockResolvedValue([library1, library2]);
      await expect(sut.handleQueueCleanup()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.LibraryDelete, data: { id: library1.id } },
        { name: JobName.LibraryDelete, data: { id: library2.id } },
      ]);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      mocks.library.getAll.mockResolvedValue([]);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
    });

    it('should throw an error if an import path is invalid', async () => {
      const library = factory.library();

      mocks.library.update.mockResolvedValue(library);
      mocks.library.get.mockResolvedValue(library);

      await expect(sut.update('library-id', { importPaths: ['foo/bar'] })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.library.update).not.toHaveBeenCalled();
    });

    it('should update library', async () => {
      const library = factory.library();

      mocks.library.update.mockResolvedValue(library);
      mocks.library.get.mockResolvedValue(library);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      const cwd = process.cwd();

      await expect(sut.update('library-id', { importPaths: [`${cwd}/foo/bar`] })).resolves.toEqual(mapLibrary(library));
      expect(mocks.library.update).toHaveBeenCalledWith(
        'library-id',
        expect.objectContaining({ importPaths: [`${cwd}/foo/bar`] }),
      );
    });
  });

  describe('onShutdown', () => {
    it('should do nothing if instance does not have the watch lock', async () => {
      await sut.onShutdown();
    });
  });

  describe('watchAll', () => {
    it('should return false if instance does not have the watch lock', async () => {
      await expect(sut.watchAll()).resolves.toBe(false);
    });

    describe('watching disabled', () => {
      beforeEach(async () => {
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchDisabled as SystemConfig });
      });

      it('should not watch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).not.toHaveBeenCalled();
      });
    });

    describe('watching enabled', () => {
      beforeEach(async () => {
        mocks.library.getAll.mockResolvedValue([]);
        mocks.cron.create.mockResolvedValue();

        await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      });

      it('should watch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).toHaveBeenCalledWith(library.importPaths, expect.anything(), expect.anything());
      });

      it('should exclude paths from the watcher', async () => {
        const library = factory.library({
          importPaths: ['/foo', '/bar'],
          exclusionPatterns: ['**/excluded/**'],
        });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).toHaveBeenCalledWith(
          library.importPaths,
          expect.objectContaining({ ignored: library.exclusionPatterns }),
          expect.anything(),
        );
      });

      it('should watch and unwatch library', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.getAll.mockResolvedValue([library]);
        mocks.library.get.mockResolvedValue(library);
        const mockClose = vitest.fn();
        mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));

        await sut.watchAll();
        await sut.unwatch(library.id);

        expect(mockClose).toHaveBeenCalled();
      });

      it('should not watch library without import paths', async () => {
        const library = factory.library();

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);

        await sut.watchAll();

        expect(mocks.storage.watch).not.toHaveBeenCalled();
      });

      it('should handle a new file event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
        mocks.storage.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.jpg' }] }));

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths: ['/foo/photo.jpg'],
          },
        });
      });

      it('should handle a file change event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(AssetFactory.create());
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'change', value: '/foo/photo.jpg' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths: ['/foo/photo.jpg'],
          },
        });
      });

      it('should handle a file unlink event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });
        const asset = AssetFactory.create();

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'unlink', value: asset.originalPath }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.LibraryRemoveAsset,
          data: {
            libraryId: library.id,
            paths: [asset.originalPath],
          },
        });
      });

      it('should handle an error event', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });
        const asset = AssetFactory.create({ libraryId: library.id, isExternal: true });

        mocks.library.get.mockResolvedValue(library);
        mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(asset);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({
            items: [{ event: 'error', value: 'Error!' }],
          }),
        );

        await expect(sut.watchAll()).resolves.toBeUndefined();
      });

      it('should not import a file with unknown extension', async () => {
        const library = factory.library({ importPaths: ['/foo', '/bar'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(makeMockWatcher({ items: [{ event: 'add', value: '/foo/photo.xyz' }] }));

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths', async () => {
        const library = factory.library({ importPaths: ['/xyz', '/asdf'], exclusionPatterns: ['**/dir1/**'] });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'add', value: '/dir1/photo.txt' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });

      it('should ignore excluded paths without case sensitivity', async () => {
        const library = factory.library({
          importPaths: ['/xyz', '/asdf'],
          exclusionPatterns: ['**/dir1/**'],
        });

        mocks.library.get.mockResolvedValue(library);
        mocks.library.getAll.mockResolvedValue([library]);
        mocks.storage.watch.mockImplementation(
          makeMockWatcher({ items: [{ event: 'add', value: '/DIR1/photo.txt' }] }),
        );

        await sut.watchAll();

        expect(mocks.job.queue).not.toHaveBeenCalled();
      });
    });
  });

  describe('teardown', () => {
    it('should tear down all watchers', async () => {
      const library1 = factory.library({ importPaths: ['/foo', '/bar'] });
      const library2 = factory.library({ importPaths: ['/xyz', '/asdf'] });

      mocks.library.getAll.mockResolvedValue([library1, library2]);
      mocks.library.get.mockImplementation((id) =>
        Promise.resolve([library1, library2].find((library) => library.id === id)),
      );

      const mockClose = vitest.fn();
      mocks.storage.watch.mockImplementation(makeMockWatcher({ close: mockClose }));
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.libraryWatchEnabled as SystemConfig });
      await sut.onShutdown();

      expect(mockClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleDeleteLibrary', () => {
    it('should delete an empty library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.library.streamAssetIds.mockReturnValue(makeStream([]));

      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.library.delete).toHaveBeenCalled();
    });

    it('should delete all assets in a library', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);
      mocks.library.streamAssetIds.mockReturnValue(makeStream([AssetFactory.create()]));

      await expect(sut.handleDeleteLibrary({ id: library.id })).resolves.toBe(JobStatus.Success);
    });
  });

  describe('queueScan', () => {
    it('should queue a library scan', async () => {
      const library = factory.library();

      mocks.library.get.mockResolvedValue(library);

      await sut.queueScan(library.id);

      expect(mocks.job.queue).toHaveBeenCalledTimes(2);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncFilesQueueAll,
        data: { id: library.id },
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibrarySyncAssetsQueueAll,
        data: { id: library.id },
      });
    });
  });

  describe('handleQueueAllScan', () => {
    it('should queue the refresh job', async () => {
      const library = factory.library();

      mocks.library.getAll.mockResolvedValue([library]);

      await expect(sut.handleQueueScanAll()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibraryDeleteCheck,
        data: {},
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.LibrarySyncFilesQueueAll, data: { id: library.id } },
      ]);
    });
  });

  describe('validate', () => {
    it('should not require import paths', async () => {
      await expect(sut.validate('library-id', {})).resolves.toEqual({ importPaths: [] });
    });

    it('should validate directory', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      mocks.storage.checkFileExists.mockResolvedValue(true);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: true,
            message: undefined,
          },
        ],
      });
    });

    it('should detect when path does not exist', async () => {
      mocks.storage.stat.mockImplementation(() => {
        const error = { code: 'ENOENT' } as any;
        throw error;
      });

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            message: 'Path does not exist (ENOENT)',
          },
        ],
      });
    });

    it('should detect when path is not a directory', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => false,
      } as Stats);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/file'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/file',
            isValid: false,
            message: 'Not a directory',
          },
        ],
      });
    });

    it('should return an unknown exception from stat', async () => {
      mocks.storage.stat.mockImplementation(() => {
        throw new Error('Unknown error');
      });

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            message: 'Error: Unknown error',
          },
        ],
      });
    });

    it('should detect when access rights are missing', async () => {
      mocks.storage.stat.mockResolvedValue({
        isDirectory: () => true,
      } as Stats);

      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(sut.validate('library-id', { importPaths: ['/external/user1/'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: '/external/user1/',
            isValid: false,
            message: 'Lacking read permission for folder',
          },
        ],
      });
    });

    it('should detect when import path is not absolute', async () => {
      const cwd = process.cwd();

      await expect(sut.validate('library-id', { importPaths: ['relative/path'] })).resolves.toEqual({
        importPaths: [
          {
            importPath: 'relative/path',
            isValid: false,
            message: `Import path must be absolute, try ${cwd}/relative/path`,
          },
        ],
      });
    });

    it('should detect when import path is in immich media folder', async () => {
      const importPaths = ['/data/thumbs', `${process.cwd()}/xyz`, '/data/library'];
      const library = factory.library({ importPaths });

      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);

      mocks.storage.checkFileExists.mockImplementation((importPath) => Promise.resolve(importPath === importPaths[1]));

      await expect(sut.validate(library.id, { importPaths })).resolves.toEqual({
        importPaths: [
          {
            importPath: importPaths[0],
            isValid: false,
            message: 'Cannot use media upload folder for external libraries',
          },
          {
            importPath: importPaths[1],
            isValid: true,
          },
          {
            importPath: importPaths[2],
            isValid: false,
            message: 'Cannot use media upload folder for external libraries',
          },
        ],
      });
    });
  });
});
