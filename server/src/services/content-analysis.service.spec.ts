import { AssetType, AssetVisibility, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { ContentAnalysisService } from 'src/services/content-analysis.service.js';
import { CONTENT_ANALYSIS_VERSION } from 'src/utils/content-analysis.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const MACOS_15 = { version: 2, macos: '15.6.0', features: ['classify', 'aesthetics', 'animals', 'barcodes'] };
const MACOS_26 = { version: 2, macos: '26.1.0', features: [...MACOS_15.features, 'documents', 'smudge', 'speech'] };
const IMAGE_TASKS_15 = ['classify', 'aesthetics', 'animals', 'barcodes'];
const IMAGE_TASKS_26 = [...IMAGE_TASKS_15, 'documents', 'smudge'];

const config = (contentAnalysis: { tags?: boolean; archiveScreenshots?: boolean; speech?: boolean }) => ({
  machineLearning: {
    contentAnalysis: {
      enabled: true,
      tags: true,
      archiveScreenshots: false,
      speech: true,
      speechLanguage: 'zh-CN' as const,
      ...contentAnalysis,
    },
  },
});

describe(ContentAnalysisService.name, () => {
  let sut: ContentAnalysisService;
  let mocks: ServiceMocks;

  const asset = {
    id: 'asset-1',
    ownerId: 'user-1',
    visibility: AssetVisibility.Timeline,
    type: AssetType.Image,
    originalFileName: 'IMG_0001.HEIC',
    originalPath: '/library/IMG_0001.HEIC',
    width: 4032,
    height: 3024,
    stackId: null,
    stackIsAutomatic: null,
    stackPrimaryAssetId: null,
    make: 'Apple',
    model: 'iPhone 16',
    exifImageWidth: 4032,
    exifImageHeight: 3024,
    previewFile: '/thumbs/preview.jpeg',
  };
  const video = {
    ...asset,
    id: 'video-1',
    type: AssetType.Video,
    originalFileName: 'IMG_0002.MOV',
    originalPath: '/library/IMG_0002.MOV',
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
  const speech = {
    audio: true,
    seconds: 12.5,
    language: 'zh-CN',
    segments: [
      { start: 0.5, end: 2, text: '生日快乐' },
      { start: 3, end: 5, text: '宝宝吹蜡烛' },
    ],
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ContentAnalysisService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    mocks.vision.isAvailable.mockReturnValue(true);
    mocks.vision.getCapabilities.mockResolvedValue(MACOS_15);
    mocks.vision.analyze.mockResolvedValue(vision);
    mocks.vision.getByAssetId.mockResolvedValue(undefined);
    mocks.assetJob.getForContentAnalysis.mockResolvedValue(asset);
    mocks.tag.upsertValue.mockImplementation(({ value }) => Promise.resolve({ id: `tag:${value}`, value } as any));
    mocks.stack.update.mockResolvedValue({} as any);
  });

  describe('onBootstrap', () => {
    it('queues what is missing, unless that is queued already', async () => {
      mocks.job.getJobCounts.mockResolvedValue({ waiting: 0, active: 0 } as any);
      await sut.onBootstrap();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.ContentAnalysisQueueAll, data: { force: false } });
      expect(mocks.job.getJobCounts).toHaveBeenCalledWith(QueueName.ContentAnalysis);

      mocks.job.queue.mockClear();
      mocks.job.getJobCounts.mockResolvedValue({ waiting: 12, active: 2 } as any);
      await sut.onBootstrap();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('does nothing without the helper', async () => {
      mocks.vision.isAvailable.mockReturnValue(false);
      await sut.onBootstrap();
      expect(mocks.vision.getCapabilities).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('handleQueueAll', () => {
    it('queues the assets missing what this Mac does', async () => {
      const queued = AssetFactory.create();
      mocks.assetJob.streamForContentAnalysis.mockReturnValue(makeStream([queued]));

      expect(await sut.handleQueueAll({ force: false })).toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForContentAnalysis).toHaveBeenCalledWith(
        CONTENT_ANALYSIS_VERSION,
        IMAGE_TASKS_15,
        IMAGE_TASKS_15,
        false,
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.ContentAnalysis, data: { id: queued.id } }]);
    });

    it("on macOS 26, also those missing its requests, and a video's speech", async () => {
      mocks.vision.getCapabilities.mockResolvedValue(MACOS_26);
      mocks.assetJob.streamForContentAnalysis.mockReturnValue(makeStream([]));

      await sut.handleQueueAll({ force: false });

      expect(mocks.assetJob.streamForContentAnalysis).toHaveBeenCalledWith(
        CONTENT_ANALYSIS_VERSION,
        IMAGE_TASKS_26,
        [...IMAGE_TASKS_26, 'speech'],
        false,
      );
    });

    it("leaves out a video's speech with speech off", async () => {
      mocks.vision.getCapabilities.mockResolvedValue(MACOS_26);
      mocks.systemMetadata.get.mockResolvedValue(config({ speech: false }));
      mocks.assetJob.streamForContentAnalysis.mockReturnValue(makeStream([]));

      await sut.handleQueueAll({ force: true });

      expect(mocks.assetJob.streamForContentAnalysis).toHaveBeenCalledWith(
        CONTENT_ANALYSIS_VERSION,
        IMAGE_TASKS_26,
        IMAGE_TASKS_26,
        true,
      );
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

      expect(mocks.vision.analyze).toHaveBeenCalledTimes(1);
      expect(mocks.vision.analyze).toHaveBeenCalledWith('/thumbs/preview.jpeg', IMAGE_TASKS_15);
      expect(mocks.vision.upsert).toHaveBeenCalledWith({
        assetId: asset.id,
        version: CONTENT_ANALYSIS_VERSION,
        features: IMAGE_TASKS_15,
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

    it('does not listen to a video before macOS 26', async () => {
      mocks.assetJob.getForContentAnalysis.mockResolvedValue(video);

      await sut.handleContentAnalysis({ id: video.id });

      expect(mocks.vision.analyze).toHaveBeenCalledTimes(1);
      expect(mocks.vision.analyze).toHaveBeenCalledWith('/thumbs/preview.jpeg', IMAGE_TASKS_15);
      expect(mocks.vision.upsert).toHaveBeenCalledWith(expect.not.objectContaining({ transcript: expect.anything() }));
    });

    it('on macOS 26, listens to a video and keeps what is said, for search', async () => {
      mocks.vision.getCapabilities.mockResolvedValue(MACOS_26);
      mocks.assetJob.getForContentAnalysis.mockResolvedValue(video);
      mocks.vision.analyze.mockImplementation((_path, tasks) =>
        Promise.resolve(
          tasks.includes('speech')
            ? { id: 'speech', speech }
            : { ...vision, documents: { count: 0 }, smudge: { confidence: 0.1 } },
        ),
      );

      expect(await sut.handleContentAnalysis({ id: video.id })).toBe(JobStatus.Success);

      expect(mocks.vision.analyze).toHaveBeenCalledWith('/thumbs/preview.jpeg', IMAGE_TASKS_26);
      expect(mocks.vision.analyze).toHaveBeenCalledWith('/library/IMG_0002.MOV', ['speech'], {
        language: 'zh-CN',
        timeout: expect.any(Number),
      });
      expect(mocks.vision.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          features: [...IMAGE_TASKS_26, 'speech'],
          isDocument: false,
          smudge: 0.1,
          transcript: '生日 日快 快乐 宝宝 宝吹 吹蜡 蜡烛',
          transcriptSegments: speech.segments,
          transcriptLanguage: 'zh-CN',
        }),
      );
    });

    it('keeps the rest when listening fails, and listens again next time', async () => {
      mocks.vision.getCapabilities.mockResolvedValue(MACOS_26);
      mocks.assetJob.getForContentAnalysis.mockResolvedValue(video);
      mocks.vision.analyze.mockImplementation((_path, tasks) =>
        tasks.includes('speech')
          ? Promise.reject(new Error('immich-vision took more than 1800 s'))
          : Promise.resolve({ ...vision, documents: { count: 0 }, smudge: { confidence: 0.1 } }),
      );

      expect(await sut.handleContentAnalysis({ id: video.id })).toBe(JobStatus.Success);

      const row = mocks.vision.upsert.mock.calls[0][0];
      expect(row.features).toEqual(IMAGE_TASKS_26);
      expect(row).not.toHaveProperty('transcript');
    });

    it('keeps the transcript it has when speech is turned off', async () => {
      mocks.vision.getCapabilities.mockResolvedValue(MACOS_26);
      mocks.systemMetadata.get.mockResolvedValue(config({ speech: false }));
      mocks.assetJob.getForContentAnalysis.mockResolvedValue(video);
      mocks.vision.getByAssetId.mockResolvedValue({
        version: CONTENT_ANALYSIS_VERSION,
        features: [...IMAGE_TASKS_26, 'speech'],
      } as any);
      mocks.vision.analyze.mockResolvedValue({ ...vision, documents: { count: 0 }, smudge: { confidence: 0.1 } });

      await sut.handleContentAnalysis({ id: video.id });

      expect(mocks.vision.analyze).toHaveBeenCalledTimes(1);
      const row = mocks.vision.upsert.mock.calls[0][0];
      expect(row.features).toEqual(['speech', ...IMAGE_TASKS_26]);
      expect(row).not.toHaveProperty('transcript');
    });

    it('on macOS 26, tags a document, a table, a smudged lens', async () => {
      mocks.vision.getCapabilities.mockResolvedValue(MACOS_26);
      mocks.vision.analyze.mockResolvedValue({
        ...vision,
        classify: [],
        animals: [],
        documents: { count: 1, confidence: 0.95, lines: 20, paragraphs: 3, tables: 1, lists: 0, title: '发票' },
        smudge: { confidence: 0.93 },
      });

      await sut.handleContentAnalysis({ id: asset.id });

      expect(mocks.vision.upsert).toHaveBeenCalledWith(expect.objectContaining({ isDocument: true, smudge: 0.93 }));
      expect(mocks.vision.replaceAutoTags).toHaveBeenCalledWith(asset.id, [
        'tag:自动/文档/表格',
        'tag:自动/质量/镜头脏污',
      ]);
    });

    it('does not take a little text for a document, nor a slight smudge for one', async () => {
      mocks.vision.getCapabilities.mockResolvedValue(MACOS_26);
      mocks.vision.analyze.mockResolvedValue({
        ...vision,
        classify: [],
        animals: [],
        documents: { count: 1, confidence: 0.9, lines: 2, paragraphs: 1, tables: 0, lists: 0, title: '' },
        smudge: { confidence: 0.6 },
      });

      await sut.handleContentAnalysis({ id: asset.id });

      expect(mocks.vision.upsert).toHaveBeenCalledWith(expect.objectContaining({ isDocument: false, smudge: 0.6 }));
      expect(mocks.vision.replaceAutoTags).toHaveBeenCalledWith(asset.id, []);
    });

    it('makes the better taken photo the cover of its automatic stack', async () => {
      mocks.assetJob.getForContentAnalysis.mockResolvedValue({
        ...asset,
        stackId: 'stack-1',
        stackIsAutomatic: true,
        stackPrimaryAssetId: 'blurry',
      });
      const member = { type: AssetType.Image, isFavorite: false, rating: null, width: 4032, height: 3024 };
      mocks.stack.getAutoStackMembers.mockResolvedValue([
        { ...member, id: 'blurry', originalFileName: 'IMG_0001.HEIC', aestheticScore: 0.1, fileCreatedAt: new Date(1) },
        { ...member, id: asset.id, originalFileName: 'IMG_0002.HEIC', aestheticScore: 0.4, fileCreatedAt: new Date(2) },
      ] as any);

      await sut.handleContentAnalysis({ id: asset.id });

      expect(mocks.stack.update).toHaveBeenCalledWith('stack-1', { primaryAssetId: asset.id });
      expect(mocks.event.emit).toHaveBeenCalledWith('StackUpdate', { stackId: 'stack-1', userId: 'user-1' });
    });

    it('keeps the cover for a slight difference, a raw file, or a stack someone chose the cover of', async () => {
      const member = { type: AssetType.Image, isFavorite: false, rating: null, width: 4032, height: 3024 };
      const stacked = { ...asset, stackId: 'stack-1', stackIsAutomatic: true, stackPrimaryAssetId: 'cover' };
      mocks.assetJob.getForContentAnalysis.mockResolvedValue(stacked);

      mocks.stack.getAutoStackMembers.mockResolvedValue([
        { ...member, id: 'cover', originalFileName: 'A.HEIC', aestheticScore: 0.38, fileCreatedAt: new Date(1) },
        { ...member, id: asset.id, originalFileName: 'B.HEIC', aestheticScore: 0.4, fileCreatedAt: new Date(2) },
      ] as any);
      await sut.handleContentAnalysis({ id: asset.id });

      mocks.stack.getAutoStackMembers.mockResolvedValue([
        { ...member, id: 'cover', originalFileName: 'A.JPG', aestheticScore: 0.1, fileCreatedAt: new Date(1) },
        { ...member, id: asset.id, originalFileName: 'A.ARW', aestheticScore: 0.6, fileCreatedAt: new Date(1) },
      ] as any);
      await sut.handleContentAnalysis({ id: asset.id });

      mocks.assetJob.getForContentAnalysis.mockResolvedValue({ ...stacked, stackIsAutomatic: false });
      await sut.handleContentAnalysis({ id: asset.id });

      expect(mocks.stack.getAutoStackMembers).toHaveBeenCalledTimes(2);
      expect(mocks.stack.update).not.toHaveBeenCalled();
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
      mocks.systemMetadata.get.mockResolvedValue(config({ archiveScreenshots: true }));
      const screenshot = { ...asset, originalFileName: 'Screenshot_1.png', make: null, model: null };
      mocks.assetJob.getForContentAnalysis.mockResolvedValue(screenshot);

      await sut.handleContentAnalysis({ id: asset.id });
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: asset.id, visibility: AssetVisibility.Archive });

      // analyzed before: the user may have taken it out of the archive
      mocks.asset.update.mockClear();
      mocks.vision.getByAssetId.mockResolvedValue({ assetId: asset.id, features: [] } as any);
      await sut.handleContentAnalysis({ id: asset.id });
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('tags nothing with tags off', async () => {
      mocks.systemMetadata.get.mockResolvedValue(config({ tags: false }));

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
        ...video,
        originalFileName: 'Screen Recording.mov',
        make: null,
        model: null,
        exifImageWidth: 1179,
        exifImageHeight: 2556,
      });

      await sut.handleContentAnalysis({ id: video.id });

      expect(mocks.vision.upsert).toHaveBeenCalledWith(expect.objectContaining({ isScreenshot: false }));
    });
  });
});
