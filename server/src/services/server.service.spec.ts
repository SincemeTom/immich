import { SystemMetadataKey } from 'src/enum.js';
import { ServerService } from 'src/services/server.service.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(ServerService.name, () => {
  let sut: ServerService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ServerService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getStorage', () => {
    const auth = factory.auth();

    beforeEach(() => {
      mocks.user.getUsage.mockResolvedValue({ uploads: 0, external: 0 });
    });

    it.each([
      { total: 500, available: 300, size: '500 B', free: '300 B' },
      { total: 500_000, available: 300_000, size: '488.3 KiB', free: '293.0 KiB' },
      { total: 500_000_000, available: 300_000_000, size: '476.8 MiB', free: '286.1 MiB' },
      { total: 500_000_000_000, available: 300_000_000_000, size: '465.7 GiB', free: '279.4 GiB' },
      { total: 500_000_000_000_000, available: 300_000_000_000_000, size: '454.7 TiB', free: '272.8 TiB' },
      { total: 500_000_000_000_000_000, available: 300_000_000_000_000_000, size: '444.1 PiB', free: '266.5 PiB' },
    ])('should return the disk space as $size', async ({ total, available, size, free }) => {
      mocks.storage.checkDiskUsage.mockResolvedValue({ free: 200, available, total });

      await expect(sut.getStorage(auth)).resolves.toMatchObject({
        diskAvailable: free,
        diskAvailableRaw: available,
        diskSize: size,
        diskSizeRaw: total,
      });

      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
    });

    it("should return what the user's photos take, uploaded and of their external libraries", async () => {
      mocks.storage.checkDiskUsage.mockResolvedValue({ free: 200_000, available: 300_000, total: 1_000_000 });
      mocks.user.getUsage.mockResolvedValue({ uploads: 100_000, external: 150_000 });

      const withQuota = factory.auth({ user: { quotaSizeInBytes: 200_000 } });

      await expect(sut.getStorage(withQuota)).resolves.toEqual({
        diskAvailable: '293.0 KiB',
        diskAvailableRaw: 300_000,
        diskSize: '976.6 KiB',
        diskSizeRaw: 1_000_000,
        diskUse: '244.1 KiB',
        diskUseRaw: 250_000,
        diskUsagePercentage: 25,
        usageUploads: 100_000,
        usageExternal: 150_000,
        quotaSizeInBytes: 200_000,
        sharesNotCounted: 0,
      });
      expect(mocks.user.getUsage).toHaveBeenCalledWith(withQuota.user.id);
    });

    describe('with network shares', () => {
      const location = '/Users/me/Library/Application Support/Immich/mounts';
      let platform: PropertyDescriptor;
      let metadata: Record<string, unknown>;

      beforeAll(() => {
        platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'darwin' });
      });

      afterAll(() => {
        Object.defineProperty(process, 'platform', platform);
      });

      beforeEach(() => {
        mocks.config.getEnv.mockReturnValue(
          mockEnvData({ storage: { ignoreMountCheckErrors: false, networkSharesLocation: location } }),
        );
        mocks.storage.checkDiskUsage.mockResolvedValue({ free: 400, available: 400, total: 1000 });
        metadata = {
          [SystemMetadataKey.NetworkShares]: {
            shares: [
              { id: 'a', name: 'A', host: 'nas', exportPath: '/volume1/a', folder: 'A', enabled: true },
              { id: 'b', name: 'B', host: 'nas', exportPath: '/volume1/b', folder: 'B', enabled: true },
              { id: 'c', name: 'C', host: 'nas2', exportPath: '/c', folder: 'C', enabled: true },
            ],
          },
          [SystemMetadataKey.NetworkShareSpace]: {
            checkedAt: new Date().toISOString(),
            mountPaths: { a: `${location}/A`, b: `${location}/B`, c: `${location}/C` },
            shares: {
              a: { total: 10_000, used: 4000, available: 6000 },
              // the same volume as a: a share of another folder on it
              b: { total: 10_000, used: 4000, available: 6000 },
            },
          },
        };
        mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve(metadata[key] ?? null) as any);
      });

      it('should count each volume of the shares that answered once', async () => {
        await expect(sut.getStorage(auth)).resolves.toMatchObject({
          diskSizeRaw: 11_000,
          diskAvailableRaw: 6400,
          sharesNotCounted: 1,
        });
      });

      it('should not count them when set not to', async () => {
        mocks.systemMetadata.get.mockImplementation(
          (key) =>
            Promise.resolve(
              key === SystemMetadataKey.SystemConfig
                ? { server: { storageIncludesNetworkShares: false } }
                : (metadata[key] ?? null),
            ) as any,
        );

        await expect(sut.getStorage(auth)).resolves.toMatchObject({
          diskSizeRaw: 1000,
          diskAvailableRaw: 400,
          sharesNotCounted: 0,
        });
      });

      it('should list each volume for the admin', async () => {
        await expect(sut.getStorageDetails()).resolves.toEqual({
          totalBytes: 11_000,
          usedBytes: 4600,
          availableBytes: 6400,
          includesNetworkShares: true,
          notCounted: 1,
          checkedAt: expect.any(String),
          volumes: [
            expect.objectContaining({ id: 'local', kind: 'local', status: 'counted', totalBytes: 1000 }),
            expect.objectContaining({ id: 'a', source: 'nas:/volume1/a', path: `${location}/A`, status: 'counted' }),
            expect.objectContaining({ id: 'b', status: 'sameVolume', sameAs: 'a' }),
            expect.objectContaining({ id: 'c', status: 'offline', totalBytes: undefined }),
          ],
        });
      });
    });
  });

  describe('ping', () => {
    it('should respond with pong', () => {
      expect(sut.ping()).toEqual({ res: 'pong' });
    });
  });

  describe('getFeatures', () => {
    it('should respond the server features', async () => {
      await expect(sut.getFeatures()).resolves.toEqual({
        smartSearch: true,
        duplicateDetection: true,
        facialRecognition: true,
        importFaces: false,
        map: true,
        reverseGeocoding: true,
        oauth: false,
        oauthAutoLaunch: false,
        ocr: true,
        passwordLogin: true,
        search: true,
        sidecar: true,
        configFile: false,
        trash: true,
        email: false,
        realtimeTranscoding: false,
        networkShares: false,
      });
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });
  });

  describe('getSystemConfig', () => {
    it('should respond the server configuration', async () => {
      await expect(sut.getSystemConfig()).resolves.toEqual({
        loginPageMessage: '',
        oauthButtonText: 'Login with OAuth',
        oauthAccountManagementUrl: '',
        trashDays: 30,
        userDeleteDelay: 7,
        isInitialized: false,
        isOnboarded: false,
        externalDomain: '',
        publicUsers: true,
        mapDarkStyleUrl: 'https://tiles.immich.cloud/v1/style/dark.json',
        mapLightStyleUrl: 'https://tiles.immich.cloud/v1/style/light.json',
        maintenanceMode: false,
        minFaces: 3,
      });
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should be initialized once an admin exists', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(sut.getSystemConfig()).resolves.toMatchObject({ isInitialized: true });
    });

    it('should be initialized when setup is disabled', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ setup: { allow: false } }));
      mocks.user.hasAdmin.mockResolvedValue(false);

      await expect(sut.getSystemConfig()).resolves.toMatchObject({ isInitialized: true });
    });
  });

  describe('getStats', () => {
    it('should total up usage by user', async () => {
      mocks.user.getUserStats.mockResolvedValue([
        {
          userId: 'user1',
          userName: '1 User',
          photos: 10,
          videos: 11,
          usage: 12_345,
          usagePhotos: 1,
          usageVideos: 11_345,
          quotaSizeInBytes: 0,
        },
        {
          userId: 'user2',
          userName: '2 User',
          photos: 10,
          videos: 20,
          usage: 123_456,
          usagePhotos: 100,
          usageVideos: 23_456,
          quotaSizeInBytes: 0,
        },
        {
          userId: 'user3',
          userName: '3 User',
          photos: 100,
          videos: 0,
          usage: 987_654,
          usagePhotos: 900,
          usageVideos: 87_654,
          quotaSizeInBytes: 0,
        },
      ]);

      await expect(sut.getStatistics()).resolves.toEqual({
        photos: 120,
        videos: 31,
        usage: 1_123_455,
        usagePhotos: 1001,
        usageVideos: 122_455,
        usageByUser: [
          {
            photos: 10,
            quotaSizeInBytes: 0,
            usage: 12_345,
            usagePhotos: 1,
            usageVideos: 11_345,
            userName: '1 User',
            userId: 'user1',
            videos: 11,
          },
          {
            photos: 10,
            quotaSizeInBytes: 0,
            usage: 123_456,
            usagePhotos: 100,
            usageVideos: 23_456,
            userName: '2 User',
            userId: 'user2',
            videos: 20,
          },
          {
            photos: 100,
            quotaSizeInBytes: 0,
            usage: 987_654,
            usagePhotos: 900,
            usageVideos: 87_654,
            userName: '3 User',
            userId: 'user3',
            videos: 0,
          },
        ],
      });

      expect(mocks.user.getUserStats).toHaveBeenCalledWith({ includeExternal: false });
    });

    it('should count the external libraries when the config says so', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ library: { includeInStatistics: true } });
      mocks.user.getUserStats.mockResolvedValue([]);

      await sut.getStatistics();

      expect(mocks.user.getUserStats).toHaveBeenCalledWith({ includeExternal: true });
    });
  });

  describe('setLicense', () => {
    it('should save license if valid', async () => {
      mocks.systemMetadata.set.mockResolvedValue();

      const license = { licenseKey: 'IMSV-license-key', activationKey: 'activation-key' };
      await sut.setLicense(license);

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.License, expect.any(Object));
    });

    it('should not save license if invalid', async () => {
      mocks.user.upsertMetadata.mockResolvedValue();

      const license = { licenseKey: 'license-key', activationKey: 'activation-key' };
      const call = sut.setLicense(license);
      await expect(call).rejects.toThrowError('Invalid license key');
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });
  });

  describe('deleteLicense', () => {
    it('should delete license', async () => {
      mocks.user.upsertMetadata.mockResolvedValue();

      await sut.deleteLicense();
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    });
  });
});
