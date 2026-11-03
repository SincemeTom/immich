import { AssetVisibility, JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { LocationInferenceService } from 'src/services/location-inference.service.js';
import { LOCATION_INFERENCE_WINDOW_MS } from 'src/utils/location-inference.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const taken = new Date('2026-10-01T10:10:00.000Z');

const asset = (overrides: Record<string, unknown> = {}) => ({
  id: 'asset-1',
  ownerId: 'user-1',
  deletedAt: null,
  visibility: AssetVisibility.Timeline,
  dateTimeOriginal: taken,
  localDateTime: taken,
  latitude: null as number | null,
  longitude: null as number | null,
  locationInferred: null as boolean | null,
  ...overrides,
});

const source = (id: string, minutes: number, latitude = 31.24, longitude = 121.49) => ({
  id,
  latitude,
  longitude,
  localDateTime: new Date(taken.getTime() + minutes * 60_000),
});

const shanghai = { city: '上海市', state: '上海市', country: '中国' };

/** whether location inference was on, as kept; the config saved, none (the defaults) */
const mockLocationInferenceState = (mocks: ServiceMocks, state?: { enabled: boolean }) =>
  mocks.systemMetadata.get.mockImplementation(
    (key) => Promise.resolve(key === SystemMetadataKey.LocationInference ? state : {}) as any,
  );

describe(LocationInferenceService.name, () => {
  let sut: LocationInferenceService;
  let mocks: ServiceMocks;

  const setConfig = (config: { enabled?: boolean; reverseGeocoding?: boolean }) =>
    mocks.systemMetadata.get.mockResolvedValue({
      metadata: { locationInference: { enabled: config.enabled ?? true } },
      reverseGeocoding: { enabled: config.reverseGeocoding ?? true },
    });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LocationInferenceService));
    mocks.map.reverseGeocode.mockResolvedValue(shanghai);
    mocks.assetJob.setInferredLocation.mockResolvedValue(true);
    mocks.assetJob.clearInferredLocations.mockResolvedValue(1);
  });

  describe('handleInferLocation', () => {
    it('infers the location of a photo between two taken close by, and names the place', async () => {
      mocks.assetJob.getForLocationInference.mockResolvedValue(asset());
      mocks.assetJob.getLocationSource
        .mockResolvedValueOnce(source('before', -10, 31.24, 121.49))
        .mockResolvedValueOnce(source('after', 30, 31.2436, 121.49));

      await expect(sut.handleInferLocation({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.getLocationSource).toHaveBeenCalledWith(
        'user-1',
        taken,
        'before',
        LOCATION_INFERENCE_WINDOW_MS,
      );
      expect(mocks.assetJob.getLocationSource).toHaveBeenCalledWith(
        'user-1',
        taken,
        'after',
        LOCATION_INFERENCE_WINDOW_MS,
      );
      expect(mocks.map.reverseGeocode).toHaveBeenCalledWith({ latitude: 31.24, longitude: 121.49 });
      expect(mocks.assetJob.setInferredLocation).toHaveBeenCalledWith('asset-1', {
        latitude: 31.24,
        longitude: 121.49,
        ...shanghai,
      });
    });

    it('goes by the local time: one without a location often has no time zone, its time taken as UTC', async () => {
      // 10:10 local; the photos around it with a location have their time zone, so their UTC times are hours off
      mocks.assetJob.getForLocationInference.mockResolvedValue(
        asset({ dateTimeOriginal: new Date('2026-10-01T02:10:00.000Z'), localDateTime: taken }),
      );
      mocks.assetJob.getLocationSource.mockResolvedValue(undefined);

      await sut.handleInferLocation({ id: 'asset-1' });

      expect(mocks.assetJob.getLocationSource).toHaveBeenCalledWith(
        'user-1',
        taken,
        'before',
        LOCATION_INFERENCE_WINDOW_MS,
      );
    });

    it('leaves the place unnamed without reverse geocoding', async () => {
      setConfig({ reverseGeocoding: false });
      mocks.assetJob.getForLocationInference.mockResolvedValue(asset());
      mocks.assetJob.getLocationSource
        .mockResolvedValueOnce(source('before', -10))
        .mockResolvedValueOnce(source('after', 30));

      await sut.handleInferLocation({ id: 'asset-1' });

      expect(mocks.map.reverseGeocode).not.toHaveBeenCalled();
      expect(mocks.assetJob.setInferredLocation).toHaveBeenCalledWith('asset-1', {
        latitude: 31.24,
        longitude: 121.49,
        city: null,
        state: null,
        country: null,
      });
    });

    it('infers none when the photos around it were taken far apart', async () => {
      mocks.assetJob.getForLocationInference.mockResolvedValue(asset());
      mocks.assetJob.getLocationSource
        .mockResolvedValueOnce(source('before', -10, 31.24, 121.49))
        .mockResolvedValueOnce(source('after', 30, 31.3, 121.49));

      await expect(sut.handleInferLocation({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.setInferredLocation).not.toHaveBeenCalled();
      expect(mocks.assetJob.clearInferredLocations).not.toHaveBeenCalled();
    });

    it('takes away an inferred location the photos around it no longer give', async () => {
      mocks.assetJob.getForLocationInference.mockResolvedValue(
        asset({ latitude: 31.24, longitude: 121.49, locationInferred: true }),
      );
      mocks.assetJob.getLocationSource.mockResolvedValue(undefined);

      await expect(sut.handleInferLocation({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.clearInferredLocations).toHaveBeenCalledWith('asset-1', false);
    });

    it('leaves an inferred location that is the same', async () => {
      mocks.assetJob.getForLocationInference.mockResolvedValue(
        asset({ latitude: 31.24, longitude: 121.49, locationInferred: true }),
      );
      mocks.assetJob.getLocationSource
        .mockResolvedValueOnce(source('before', -10))
        .mockResolvedValueOnce(source('after', 30));

      await expect(sut.handleInferLocation({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.setInferredLocation).not.toHaveBeenCalled();
    });

    it('does not infer again one its owner cleared, a hidden one, or one without a date', async () => {
      for (const overrides of [
        { locationInferred: false },
        { visibility: AssetVisibility.Hidden },
        { dateTimeOriginal: null },
        { deletedAt: new Date() },
      ]) {
        mocks.assetJob.getForLocationInference.mockResolvedValue(asset(overrides));
        await expect(sut.handleInferLocation({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
      }

      expect(mocks.assetJob.getLocationSource).not.toHaveBeenCalled();
    });

    it('with a location of its own, queues the photos taken around it, to infer theirs', async () => {
      mocks.assetJob.getForLocationInference.mockResolvedValue(asset({ latitude: 31.24, longitude: 121.49 }));
      mocks.assetJob.getLocationInferenceTargets.mockResolvedValue([{ id: 'asset-2' }, { id: 'asset-3' }]);

      await expect(sut.handleInferLocation({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.getLocationInferenceTargets).toHaveBeenCalledWith(
        'asset-1',
        'user-1',
        taken,
        LOCATION_INFERENCE_WINDOW_MS,
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetInferLocation, data: { id: 'asset-2' } },
        { name: JobName.AssetInferLocation, data: { id: 'asset-3' } },
      ]);
      expect(mocks.assetJob.getLocationSource).not.toHaveBeenCalled();
    });

    it('does nothing while it is off', async () => {
      setConfig({ enabled: false });

      await expect(sut.handleInferLocation({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.getForLocationInference).not.toHaveBeenCalled();
    });
  });

  describe('handleQueueAll', () => {
    it('queues the photos without a location, or with force those with an inferred one too', async () => {
      mocks.assetJob.streamForLocationInference.mockReturnValue(makeStream([{ id: 'asset-1' }]));

      await expect(sut.handleQueueAll({ force: true })).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForLocationInference).toHaveBeenCalledWith(true);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AssetInferLocation, data: { id: 'asset-1' } }]);
    });

    it('does nothing while it is off', async () => {
      setConfig({ enabled: false });

      await expect(sut.handleQueueAll({ force: false })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.assetJob.streamForLocationInference).not.toHaveBeenCalled();
    });
  });

  describe('onAssetMetadataExtracted', () => {
    it('queues the photo', async () => {
      await sut.onAssetMetadataExtracted({ assetId: 'asset-1', userId: 'user-1' });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AssetInferLocation, data: { id: 'asset-1' } }]);
    });

    it('does not while it is off', async () => {
      setConfig({ enabled: false });

      await sut.onAssetMetadataExtracted({ assetId: 'asset-1', userId: 'user-1' });

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('onConfigInit', () => {
    it('runs over the photos there are, the first time it is on (the upgrade that adds it)', async () => {
      mockLocationInferenceState(mocks, undefined);

      await sut.onConfigInit({ newConfig: { metadata: { locationInference: { enabled: true } } } as any });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetInferLocationQueueAll,
        data: { force: false },
      });
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.LocationInference, { enabled: true });
    });

    it('not again while it stays on', async () => {
      mockLocationInferenceState(mocks, { enabled: true });

      await sut.onConfigInit({ newConfig: { metadata: { locationInference: { enabled: true } } } as any });

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('again once it is turned on after being off', async () => {
      mockLocationInferenceState(mocks, { enabled: true });
      await sut.onConfigUpdate({
        newConfig: { metadata: { locationInference: { enabled: false } } } as any,
        oldConfig: {} as any,
      });
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.LocationInference, { enabled: false });

      mockLocationInferenceState(mocks, { enabled: false });
      await sut.onConfigUpdate({
        newConfig: { metadata: { locationInference: { enabled: true } } } as any,
        oldConfig: {} as any,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetInferLocationQueueAll,
        data: { force: false },
      });
    });
  });

  describe('clear', () => {
    it('clears the inferred location of a photo of the user, for good', async () => {
      const auth = factory.auth();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.clear(auth, 'asset-1');

      expect(mocks.assetJob.clearInferredLocations).toHaveBeenCalledWith('asset-1', true);
    });

    it('requires access to the photo', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.clear(factory.auth(), 'asset-1')).rejects.toThrow();

      expect(mocks.assetJob.clearInferredLocations).not.toHaveBeenCalled();
    });

    it('clears all of them, so that they can be inferred again', async () => {
      mocks.assetJob.clearInferredLocations.mockResolvedValue(12);

      await expect(sut.clearAll()).resolves.toEqual({ count: 12 });

      expect(mocks.assetJob.clearInferredLocations).toHaveBeenCalledWith(undefined, false);
    });
  });
});
