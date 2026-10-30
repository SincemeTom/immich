import { BadRequestException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName, JobStatus, QueueName, StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { StorageLocationService } from 'src/services/storage-location.service.js';
import { NetworkShare, NetworkShareProtocol, NfsVersion } from 'src/utils/network-share.js';
import { StorageLocations } from 'src/utils/storage-location.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const mounts = '/Users/me/Library/Application Support/Immich/mounts';
const nas = `${mounts}/NAS`;

type Reply = { code?: number; stdout?: string; stderr?: string };

const child = ({ code = 0, stdout = '', stderr = '' }: Reply) => {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  setImmediate(() => {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.emit('close', code);
  });
  return process;
};

const share = (overrides: Partial<NetworkShare> = {}): NetworkShare => ({
  id: 'share-id',
  name: 'NAS',
  protocol: NetworkShareProtocol.Nfs,
  host: '192.168.1.10',
  exportPath: '/volume1/immich',
  nfsVersion: NfsVersion.Auto,
  readOnly: false,
  folder: 'NAS',
  enabled: true,
  createdAt: '2026-10-30T00:00:00.000Z',
  ...overrides,
});

async function* rows<T>(items: T[]) {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

const stat = (size: number) => ({ size, atime: new Date(1), mtime: new Date(2), isFile: () => true }) as any;

describe(StorageLocationService.name, () => {
  let sut: StorageLocationService;
  let mocks: ServiceMocks;
  let platform: PropertyDescriptor;
  let metadata: Map<SystemMetadataKey, any>;
  let mounted: Set<string>;
  /** folders on the "NAS": their entries */
  let folders: Map<string, string[]>;
  let markers: Set<string>;
  let user: ReturnType<typeof UserFactory.create>;

  const locations = () => metadata.get(SystemMetadataKey.StorageLocations) as StorageLocations;
  const state = () => metadata.get(SystemMetadataKey.StorageLocationState);
  const spawned = (command: string) =>
    mocks.process.spawn.mock.calls.filter((call) => call[0] === command).map((call) => call[1] as string[]);

  beforeAll(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageLocationService));
    metadata = new Map<SystemMetadataKey, any>([[SystemMetadataKey.NetworkShares, { shares: [share()] }]]);
    mounted = new Set([nas]);
    folders = new Map([[nas, ['photos']]]);
    markers = new Set();
    user = UserFactory.create({ email: 'petyr@example.com', storageLabel: 'petyr' });

    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ storage: { ignoreMountCheckErrors: false, networkSharesLocation: mounts } }),
    );
    mocks.storage.realpath.mockImplementation((path) => Promise.resolve(path));
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve(structuredClone(metadata.get(key))));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, structuredClone(value));
      return Promise.resolve();
    });
    mocks.library.getAll.mockResolvedValue([]);
    mocks.user.get.mockResolvedValue(user as any);
    mocks.user.getList.mockResolvedValue([user] as any);
    mocks.job.isPaused.mockResolvedValue(false);
    mocks.process.spawn.mockImplementation(((command: string, args: string[]) => {
      const target = args.at(-1)!;
      switch (command) {
        case '/sbin/mount': {
          return child({ stdout: [...mounted].map((path) => `nas:/volume1/immich on ${path} (nfs)`).join('\n') });
        }
        case '/bin/ls': {
          const entries = folders.get(target);
          return child(entries ? { stdout: entries.join('\n') } : { code: 1, stderr: 'No such file or directory' });
        }
        case '/bin/mkdir': {
          folders.set(target, folders.get(target) ?? []);
          return child({});
        }
        case '/usr/bin/touch': {
          markers.add(target);
          return child({});
        }
        case '/bin/test': {
          return child({ code: markers.has(target) ? 0 : 1 });
        }
      }
      throw new Error(`unexpected command ${command}`);
    }) as any);
  });

  describe('setFolder', () => {
    it('should keep thumbnails on the share, and move the ones there now', async () => {
      const response = await sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: '/immich/thumbs/' });

      expect(spawned('/bin/mkdir')).toEqual([['-p', `${nas}/immich/thumbs`]]);
      expect(markers).toEqual(new Set([`${nas}/immich/thumbs/.immich`]));
      expect(locations()).toEqual({
        folders: { thumbs: { shareId: 'share-id', path: 'immich/thumbs' } },
        users: {},
        pending: { thumbs: ['/data/thumbs'] },
      });
      expect(StorageCore.getBaseFolder(StorageFolder.Thumbnails)).toBe(`${nas}/immich/thumbs`);
      expect(
        StorageCore.getImagePath(
          { id: 'asset-id', ownerId: 'user-id' },
          {
            fileType: 'thumbnail' as any,
            format: 'webp' as any,
            isEdited: false,
          },
        ),
      ).toBe(`${nas}/immich/thumbs/user-id/as/se/asset-id_thumbnail.webp`);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('StorageLocationUpdate');
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageLocationMigration });
      expect(response.folders[0]).toMatchObject({
        folder: StorageFolder.Thumbnails,
        location: { shareId: 'share-id', shareName: 'NAS', path: 'immich/thumbs' },
        absolutePath: `${nas}/immich/thumbs`,
        available: true,
        pendingFrom: ['/data/thumbs'],
      });
    });

    it('should move them back to the media location', async () => {
      await sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'immich/thumbs' });
      await sut.setFolder(StorageFolder.Thumbnails, { shareId: null });

      expect(locations().folders).toEqual({});
      expect(locations().pending.thumbs).toEqual([`${nas}/immich/thumbs`]);
      expect(StorageCore.getBaseFolder(StorageFolder.Thumbnails)).toBe('/data/thumbs');
    });

    it.each([
      { name: 'a share that does not exist', dto: { shareId: '00000000-0000-4000-8000-000000000000', path: 'x' } },
      { name: 'the top of the share', dto: { shareId: 'share-id', path: '/' } },
      { name: 'a path out of the share', dto: { shareId: 'share-id', path: 'immich/../../etc' } },
    ])('should refuse $name', async ({ dto }) => {
      await expect(sut.setFolder(StorageFolder.Thumbnails, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(locations()).toBeUndefined();
    });

    it('should refuse a share that is not mounted, or read-only', async () => {
      mounted.clear();
      await expect(sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'x' })).rejects.toThrow(
        'not mounted',
      );

      metadata.set(SystemMetadataKey.NetworkShares, { shares: [share({ readOnly: true })] });
      await expect(sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'x' })).rejects.toThrow(
        'read-only',
      );
    });

    it('should refuse a folder with files of someone else in it', async () => {
      folders.set(`${nas}/photos`, ['.DS_Store', '2024']);
      await expect(sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'photos' })).rejects.toThrow(
        'not empty',
      );

      folders.set(`${nas}/empty`, ['.DS_Store', '@eaDir']);
      await expect(
        sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'empty' }),
      ).resolves.toBeDefined();
    });

    it('should refuse a folder an external library imports from', async () => {
      mocks.library.getAll.mockResolvedValue([factory.library({ name: 'Family', importPaths: [`${nas}/x/2024`] })]);
      await expect(sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'x' })).rejects.toThrow(
        'Family imports from inside this folder',
      );
    });

    it('should refuse a folder another location is in, or holds', async () => {
      await sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'immich/thumbs' });
      await expect(sut.setFolder(StorageFolder.EncodedVideo, { shareId: 'share-id', path: 'immich' })).rejects.toThrow(
        'thumbs',
      );
      await expect(
        sut.setFolder(StorageFolder.EncodedVideo, { shareId: 'share-id', path: 'immich/encoded-video' }),
      ).resolves.toBeDefined();
    });
  });

  describe('setUser', () => {
    it("should keep a user's originals on the share, moved by the storage template migration", async () => {
      await sut.setUser(user.id, { shareId: 'share-id', path: 'petyr/Photos/Immich' });

      expect(locations().users).toEqual({ [user.id]: { shareId: 'share-id', path: 'petyr/Photos/Immich' } });
      expect(StorageCore.getLibraryFolder(user)).toBe(`${nas}/petyr/Photos/Immich`);
      expect(StorageCore.getLibraryFolder({ id: 'other', storageLabel: null })).toBe('/data/library/other');
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageTemplateMigration });
    });

    it('should refuse while the storage template is off', async () => {
      metadata.set(SystemMetadataKey.SystemConfig, { storageTemplate: { enabled: false } });
      await expect(sut.setUser(user.id, { shareId: 'share-id', path: 'petyr/Photos/Immich' })).rejects.toThrow(
        'storage template',
      );
    });

    it('should forget the location of a user who is deleted', async () => {
      await sut.setUser(user.id, { shareId: 'share-id', path: 'petyr/Photos/Immich' });
      await sut.onUserDelete(user as any);
      expect(locations().users).toEqual({});
    });
  });

  describe('onNetworkSharesChecked', () => {
    beforeEach(async () => {
      await sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'immich/thumbs' });
      metadata.set(SystemMetadataKey.StorageLocations, { ...locations(), pending: {} });
      mocks.job.queue.mockClear();
    });

    it('should pause what uses a location while its share is away, and resume it after', async () => {
      await sut.onNetworkSharesChecked({ available: { 'share-id': false } });

      expect(mocks.job.pause).toHaveBeenCalledWith(QueueName.ThumbnailGeneration);
      expect(mocks.job.pause).toHaveBeenCalledWith(QueueName.SmartSearch);
      expect(mocks.job.pause).not.toHaveBeenCalledWith(QueueName.MetadataExtraction);
      expect(state().unavailable).toEqual({ thumbs: expect.stringContaining('not mounted') });
      expect(state().pausedQueues).toContain(QueueName.ThumbnailGeneration);
      const response = await sut.getAll();
      expect(response.folders[0]).toMatchObject({ available: false });

      await sut.onNetworkSharesChecked({ available: { 'share-id': true } });

      expect(mocks.job.resume).toHaveBeenCalledWith(QueueName.ThumbnailGeneration);
      expect(state()).toMatchObject({ unavailable: {}, pausedQueues: [] });
    });

    it('should leave alone a queue someone paused', async () => {
      mocks.job.isPaused.mockImplementation((queue) => Promise.resolve(queue === QueueName.Ocr));

      await sut.onNetworkSharesChecked({ available: { 'share-id': false } });
      await sut.onNetworkSharesChecked({ available: { 'share-id': true } });

      expect(mocks.job.pause).not.toHaveBeenCalledWith(QueueName.Ocr);
      expect(mocks.job.resume).not.toHaveBeenCalledWith(QueueName.Ocr);
    });

    it('should not use a folder whose marker is gone', async () => {
      markers.clear();
      await sut.onNetworkSharesChecked({ available: { 'share-id': true } });
      expect(state().unavailable).toEqual({ thumbs: expect.stringContaining('missing') });
      expect(mocks.job.pause).toHaveBeenCalledWith(QueueName.ThumbnailGeneration);
    });

    it('should go on with a move that stopped, once nothing it needs is away', async () => {
      metadata.set(SystemMetadataKey.StorageLocations, { ...locations(), pending: { thumbs: ['/data/thumbs'] } });

      await sut.onNetworkSharesChecked({ available: { 'share-id': false } });
      expect(mocks.job.queue).not.toHaveBeenCalled();

      await sut.onNetworkSharesChecked({ available: { 'share-id': true } });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageLocationMigration });
    });
  });

  describe('handleMigration', () => {
    const exdev = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });

    beforeEach(async () => {
      await sut.setFolder(StorageFolder.Thumbnails, { shareId: 'share-id', path: 'immich/thumbs' });
      mocks.database.countFilesUnder.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
      mocks.database.streamAssetFilesUnder.mockReturnValue(
        rows([{ id: 'file-1', path: '/data/thumbs/user-id/as/se/asset_preview.jpeg' }]) as any,
      );
      mocks.database.streamPersonFilesUnder.mockReturnValue(
        rows([{ ownerId: 'user-id', personGroupId: 'group', path: '/data/thumbs/user-id/gr/ou/group.jpeg' }]) as any,
      );
      mocks.database.streamOriginalsUnder.mockReturnValue(rows([]) as any);
      mocks.storage.rename.mockRejectedValue(exdev);
      mocks.storage.stat.mockResolvedValue(stat(100));
    });

    it('should copy each file across, check it, delete the old one and record the new path', async () => {
      await expect(sut.handleMigration()).resolves.toBe(JobStatus.Success);

      const target = `${nas}/immich/thumbs/user-id/as/se/asset_preview.jpeg`;
      expect(mocks.storage.copyFile).toHaveBeenCalledWith('/data/thumbs/user-id/as/se/asset_preview.jpeg', target);
      expect(mocks.storage.utimes).toHaveBeenCalledWith(target, new Date(1), new Date(2));
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/data/thumbs/user-id/as/se/asset_preview.jpeg');
      expect(mocks.database.updateAssetFilePath).toHaveBeenCalledWith(
        'file-1',
        '/data/thumbs/user-id/as/se/asset_preview.jpeg',
        target,
      );
      expect(mocks.database.updatePersonFilePath).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-id', personGroupId: 'group' }),
        '/data/thumbs/user-id/gr/ou/group.jpeg',
        `${nas}/immich/thumbs/user-id/gr/ou/group.jpeg`,
      );
      expect(locations().pending).toEqual({ thumbs: [] });
      expect(mocks.storage.removeEmptyDirs).toHaveBeenCalledWith('/data/thumbs');
    });

    it('should leave a file whose copy is not whole where it is, and try again later', async () => {
      mocks.storage.stat.mockReset();
      mocks.storage.stat.mockResolvedValueOnce(stat(100)).mockResolvedValueOnce(stat(40)).mockResolvedValue(stat(100));
      mocks.database.countFilesUnder.mockReset();
      mocks.database.countFilesUnder.mockResolvedValue(1);

      await sut.handleMigration();

      expect(mocks.storage.unlink).toHaveBeenCalledWith(`${nas}/immich/thumbs/user-id/as/se/asset_preview.jpeg`);
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith('/data/thumbs/user-id/as/se/asset_preview.jpeg');
      expect(mocks.database.updateAssetFilePath).not.toHaveBeenCalled();
      expect(locations().pending).toEqual({ thumbs: ['/data/thumbs'] });
    });

    it('should rename a file on the same device', async () => {
      mocks.storage.rename.mockResolvedValue();
      await sut.handleMigration();
      expect(mocks.storage.copyFile).not.toHaveBeenCalled();
      expect(mocks.database.updateAssetFilePath).toHaveBeenCalled();
    });

    it('should stop after many failures in a row, as the NAS has likely gone', async () => {
      mocks.database.streamAssetFilesUnder.mockReturnValue(
        rows(Array.from({ length: 50 }, (_, i) => ({ id: `file-${i}`, path: `/data/thumbs/u/${i}.jpeg` }))) as any,
      );
      mocks.storage.rename.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
      mocks.database.countFilesUnder.mockReset();
      mocks.database.countFilesUnder.mockResolvedValue(51);

      await sut.handleMigration();

      expect(mocks.storage.rename).toHaveBeenCalledTimes(20);
    });

    it('should move the database backups, which the database does not name', async () => {
      mocks.database.countFilesUnder.mockReset();
      await sut.setFolder(StorageFolder.Backups, { shareId: 'share-id', path: 'immich/backups' });
      metadata.set(SystemMetadataKey.StorageLocations, { ...locations(), pending: { backups: ['/data/backups'] } });
      mocks.storage.readdir.mockResolvedValue(['.immich', 'immich-db-backup-1.sql.gz']);

      await sut.handleMigration();

      expect(mocks.storage.copyFile).toHaveBeenCalledWith(
        '/data/backups/immich-db-backup-1.sql.gz',
        `${nas}/immich/backups/immich-db-backup-1.sql.gz`,
      );
      expect(mocks.storage.copyFile).toHaveBeenCalledTimes(1);
      expect(locations().pending.backups).toEqual([]);
    });
  });

  it('should refuse the API where the server cannot mount shares', async () => {
    mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { ignoreMountCheckErrors: false } }));
    await expect(sut.getAll()).rejects.toBeInstanceOf(BadRequestException);
  });
});
