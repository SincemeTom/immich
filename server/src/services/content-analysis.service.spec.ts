import { AssetType, AssetVisibility, ImmichWorker, JobName, JobStatus } from 'src/enum.js';
import { ContentAnalysisService } from 'src/services/content-analysis.service.js';
import { CONTENT_ANALYSIS_VERSION } from 'src/utils/content-analysis.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

describe(ContentAnalysisService.name, () => {
  let sut: ContentAnalysisService;
  let mocks: ServiceMocks;

  const asset = {
    id: 'asset-1',
    ownerId: 'user-1',
    visibility: AssetVisibility.Timeline,
    type: AssetType.Image,
    originalFileName: 'IMG_0001.HEIC',
    width: 4032,
    height: 3024,
    make: 'Apple',
    model: 'iPhone 16',
    exifImageWidth: 4032,
    exifImageHeight: 3024,
    previewFile: '/thumbs/preview.jpeg',
  };

  const vision = {
    id: 'request',
    ms: 30,
    classify: [
      { label: 'animal', confidence: 0.95 },
      { label: 'cat', confidence: 0.9 },
      { label: 'outdoor', confidence: 0.8 },
    ],
    aesthetics: { score: 0.4, utility: false },
    animals: [{ label: 'Cat', confidence: 0.88 }],
    barcodes: [],
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ContentAnalysisService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    mocks.vision.isAvailable.mockReturnValue(true);
    mocks.vision.analyze.mockResolvedValue(vision);
    mocks.vision.getByAssetId.mockResolvedValue(undefined);
    mocks.assetJob.getForContentAnalysis.mockResolvedValue(asset);
    mocks.tag.upsertValue.mockImplementation(({ value }) => Promise.resolve({ id: `tag:${value}`, value } as any));
  });

  describe('handleQueueAll', () => {
    it('queues the assets not analyzed by this version', async () => {
      const queued = AssetFactory.create();
      mocks.assetJob.streamForContentAnalysis.mockReturnValue(makeStream([queued]));

      expect(await sut.handleQueueAll({ force: false })).toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForContentAnalysis).toHaveBeenCalledWith(CONTENT_ANALYSIS_VERSION, false);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.ContentAnalysis, data: { id: queued.id } }]);
      expect(mocks.vision.deleteAll).not.toHaveBeenCalled();
    });

    it('does nothing without the helper (a container, Linux)', async () => {
      mocks.vision.isAvailable.mockReturnValue(false);

      expect(await sut.handleQueueAll({ force: true })).toBe(JobStatus.Skipped);

      expect(mocks.assetJob.streamForContentAnalysis).not.toHaveBeenCalled();
    });

    it('does nothing with machine learning off', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      expect(await sut.handleQueueAll({ force: false })).toBe(JobStatus.Skipped);
    });
  });

  describe('handleContentAnalysis', () => {
    it('keeps what Vision found and tags the photo', async () => {
      expect(await sut.handleContentAnalysis({ id: asset.id })).toBe(JobStatus.Success);

      expect(mocks.vision.analyze).toHaveBeenCalledWith('/thumbs/preview.jpeg', [
        'classify',
        'aesthetics',
        'animals',
        'barcodes',
      ]);
      expect(mocks.vision.upsert).toHaveBeenCalledWith({
        assetId: asset.id,
        version: CONTENT_ANALYSIS_VERSION,
        aestheticScore: 0.4,
        isUtility: false,
        isScreenshot: false,
        labels: vision.classify,
        barcodes: [],
      });
      expect(mocks.tag.upsertValue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', value: '自动/动物/猫' }),
      );
      expect(mocks.vision.replaceAutoTags).toHaveBeenCalledWith(asset.id, ['tag:自动/动物/猫']);
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('tags a screenshot and a QR code', async () => {
      mocks.assetJob.getForContentAnalysis.mockResolvedValue({
        ...asset,
        originalFileName: 'IMG_0002.PNG',
        make: null,
        model: null,
        exifImageWidth: 1179,
        exifImageHeight: 2556,
      });
      mocks.vision.analyze.mockResolvedValue({
        ...vision,
        classify: [],
        animals: [],
        barcodes: [{ payload: 'https://example.com', symbology: 'qr' }],
      });

      await sut.handleContentAnalysis({ id: asset.id });

      expect(mocks.vision.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ isScreenshot: true, barcodes: ['https://example.com'] }),
      );
      expect(mocks.vision.replaceAutoTags).toHaveBeenCalledWith(asset.id, ['tag:自动/截图', 'tag:自动/文档/二维码']);
      // archiving screenshots is off by default
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('archives a screenshot the first time, if the settings say so', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { contentAnalysis: { enabled: true, tags: true, archiveScreenshots: true } },
      });
      const screenshot = { ...asset, originalFileName: 'Screenshot_1.png', make: null, model: null };
      mocks.assetJob.getForContentAnalysis.mockResolvedValue(screenshot);

      await sut.handleContentAnalysis({ id: asset.id });
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: asset.id, visibility: AssetVisibility.Archive });

      // analyzed before: the user may have taken it out of the archive
      mocks.asset.update.mockClear();
      mocks.vision.getByAssetId.mockResolvedValue({ assetId: asset.id } as any);
      await sut.handleContentAnalysis({ id: asset.id });
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('tags nothing with tags off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { contentAnalysis: { enabled: true, tags: false, archiveScreenshots: false } },
      });

      expect(await sut.handleContentAnalysis({ id: asset.id })).toBe(JobStatus.Success);

      expect(mocks.vision.upsert).toHaveBeenCalled();
      expect(mocks.vision.replaceAutoTags).not.toHaveBeenCalled();
    });

    it('fails an asset without a preview, skips a hidden one', async () => {
      mocks.assetJob.getForContentAnalysis.mockResolvedValue({ ...asset, previewFile: null });
      expect(await sut.handleContentAnalysis({ id: asset.id })).toBe(JobStatus.Failed);

      mocks.assetJob.getForContentAnalysis.mockResolvedValue({ ...asset, visibility: AssetVisibility.Hidden });
      expect(await sut.handleContentAnalysis({ id: asset.id })).toBe(JobStatus.Skipped);

      expect(mocks.vision.analyze).not.toHaveBeenCalled();
    });

    it('fails when Vision cannot read the preview', async () => {
      mocks.vision.analyze.mockResolvedValue({ id: 'request', error: 'cannot read /thumbs/preview.jpeg' });

      expect(await sut.handleContentAnalysis({ id: asset.id })).toBe(JobStatus.Failed);

      expect(mocks.vision.upsert).not.toHaveBeenCalled();
    });

    it('does not take a video for a screenshot', async () => {
      mocks.assetJob.getForContentAnalysis.mockResolvedValue({
        ...asset,
        type: AssetType.Video,
        originalFileName: 'Screen Recording.mov',
        make: null,
        model: null,
        exifImageWidth: 1179,
        exifImageHeight: 2556,
      });

      await sut.handleContentAnalysis({ id: asset.id });

      expect(mocks.vision.upsert).toHaveBeenCalledWith(expect.objectContaining({ isScreenshot: false }));
    });
  });
});
