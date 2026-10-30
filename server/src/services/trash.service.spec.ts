import { BadRequestException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { JobName, JobStatus } from 'src/enum.js';
import { TrashService } from 'src/services/trash.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

async function* makeAssetIdStream(count: number): AsyncIterableIterator<{ id: string }> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
    yield { id: `asset-${i + 1}` };
  }
}

describe(TrashService.name, () => {
  let sut: TrashService;
  let mocks: ServiceMocks;

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TrashService));
  });

  describe('restoreAssets', () => {
    it('should require asset restore access for all ids', async () => {
      await expect(
        sut.restoreAssets(authStub.user1, {
          ids: ['asset-1'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should handle an empty list', async () => {
      await expect(sut.restoreAssets(authStub.user1, { ids: [] })).resolves.toEqual({ count: 0 });
      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
    });

    it('should restore a batch of assets', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset1', 'asset2']));
      mocks.trash.restoreAll.mockResolvedValue(0);

      await sut.restoreAssets(authStub.user1, { ids: ['asset1', 'asset2'] });

      expect(mocks.trash.restoreAll).toHaveBeenCalledWith(['asset1', 'asset2']);
      expect(mocks.job.queue.mock.calls).toEqual([]);
    });
  });

  describe('restore', () => {
    it('should handle an empty trash', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(0));
      mocks.trash.restore.mockResolvedValue(0);
      await expect(sut.restore(authStub.user1)).resolves.toEqual({ count: 0 });
      expect(mocks.trash.restore).toHaveBeenCalledWith('user-id');
    });

    it('should restore', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(1));
      mocks.trash.restore.mockResolvedValue(1);
      await expect(sut.restore(authStub.user1)).resolves.toEqual({ count: 1 });
      expect(mocks.trash.restore).toHaveBeenCalledWith('user-id');
    });
  });

  describe('empty', () => {
    beforeEach(() => {
      mocks.trash.getOfflineLibraryIds.mockResolvedValue([]);
      mocks.trash.emptyOffline.mockResolvedValue(0);
    });

    it('should handle an empty trash', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(0));
      mocks.trash.empty.mockResolvedValue(0);
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 0 });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should empty the trash', async () => {
      mocks.trash.getDeletedIds.mockResolvedValue(makeAssetIdStream(1));
      mocks.trash.empty.mockResolvedValue(1);
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 1 });
      expect(mocks.trash.empty).toHaveBeenCalledWith('user-id');
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetEmptyTrash, data: {} });
    });
  });

  describe('empty, with files gone offline from an external library', () => {
    const library = factory.library({ id: 'library-id', importPaths: ['/nas/photos'] });

    beforeEach(() => {
      mocks.trash.empty.mockResolvedValue(1);
      mocks.trash.getOfflineLibraryIds.mockResolvedValue([library.id]);
      mocks.trash.emptyOffline.mockImplementation((_, libraryIds) => Promise.resolve(libraryIds.length > 0 ? 2 : 0));
      mocks.library.get.mockResolvedValue(library);
      mocks.storage.stat.mockResolvedValue({ isDirectory: () => true } as Stats);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.storage.readdir.mockResolvedValue(['2026']);
    });

    it('should empty them too while their library can be reached', async () => {
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 3 });
      expect(mocks.trash.emptyOffline).toHaveBeenCalledWith('user-id', ['library-id']);
      expect(mocks.storage.readdir).toHaveBeenCalledWith('/nas/photos');
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetEmptyTrash, data: {} });
    });

    it.each([
      {
        name: 'its folder is empty, as an unmounted share leaves it',
        mock: () => mocks.storage.readdir.mockResolvedValue([]),
      },
      { name: 'its folder is gone', mock: () => mocks.storage.stat.mockRejectedValue(new Error('ENOENT')) },
      { name: 'its folder is not readable', mock: () => mocks.storage.checkFileExists.mockResolvedValue(false) },
      { name: 'it is a file', mock: () => mocks.storage.stat.mockResolvedValue({ isDirectory: () => false } as Stats) },
      {
        name: 'it has no import path',
        mock: () => mocks.library.get.mockResolvedValue({ ...library, importPaths: [] }),
      },
      { name: 'it was deleted', mock: () => mocks.library.get.mockResolvedValue(void 0) },
    ])('should keep them when $name', async ({ mock }) => {
      mock();
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 1 });
      expect(mocks.trash.emptyOffline).toHaveBeenCalledWith('user-id', []);
    });

    it('should keep them when any of the import paths cannot be reached', async () => {
      mocks.library.get.mockResolvedValue({ ...library, importPaths: ['/nas/photos', '/nas/videos'] });
      mocks.storage.readdir.mockImplementation((path) => Promise.resolve(path === '/nas/videos' ? [] : ['2026']));
      await sut.empty(authStub.user1);
      expect(mocks.trash.emptyOffline).toHaveBeenCalledWith('user-id', []);
    });

    it('should decide per library', async () => {
      const other = factory.library({ id: 'other-id', importPaths: ['/nas/unmounted'] });
      mocks.trash.getOfflineLibraryIds.mockResolvedValue([library.id, other.id]);
      mocks.library.get.mockImplementation((id) => Promise.resolve(id === other.id ? other : library));
      mocks.storage.readdir.mockImplementation((path) => Promise.resolve(path === '/nas/unmounted' ? [] : ['2026']));
      await sut.empty(authStub.user1);
      expect(mocks.trash.emptyOffline).toHaveBeenCalledWith('user-id', ['library-id']);
    });
  });

  describe('onAssetsDelete', () => {
    it('should queue the empty trash job', async () => {
      await expect(sut.onAssetsDelete()).resolves.toBeUndefined();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetEmptyTrash, data: {} });
    });
  });

  describe('handleQueueEmptyTrash', () => {
    it('should queue asset delete jobs', async () => {
      mocks.trash.getDeletedIds.mockReturnValue(makeAssetIdStream(1));
      await expect(sut.handleEmptyTrash()).resolves.toEqual(JobStatus.Success);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetDelete,
          data: { id: 'asset-1', deleteOnDisk: true },
        },
      ]);
    });
  });
});
