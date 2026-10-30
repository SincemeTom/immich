import { AssetType, AssetVisibility, JobName, JobStatus, UserMetadataKey } from 'src/enum.js';
import { AutoStackService } from 'src/services/auto-stack.service.js';
import { AutoStackCandidate } from 'src/utils/auto-stack.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const taken = new Date('2026-10-28T14:00:31.297Z');

type Candidate = AutoStackCandidate & {
  ownerId: string;
  autoStackedAt: Date | null;
  isAutomatic: boolean | null;
  primaryAssetId: string | null;
};

const candidate = (originalFileName: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id: originalFileName,
  ownerId: 'user-id',
  type: AssetType.Image,
  originalFileName,
  originalPath: `/nas/photo/${originalFileName}`,
  fileCreatedAt: taken,
  isFavorite: false,
  width: 4000,
  height: 3000,
  stackId: null,
  dateTimeOriginal: taken,
  model: 'ILCE-7CM2',
  rating: null,
  autoStackId: null,
  autoStackedAt: null,
  isAutomatic: null,
  primaryAssetId: null,
  distance: null,
  ...overrides,
});

const target = (originalFileName: string, overrides: Record<string, unknown> = {}) => ({
  ...candidate(originalFileName),
  visibility: AssetVisibility.Timeline,
  deletedAt: null,
  embedding: '[0.1]',
  ...overrides,
});

describe(AutoStackService.name, () => {
  let sut: AutoStackService;
  let mocks: ServiceMocks;

  const setPreferences = (autoStack: Record<string, unknown>) =>
    mocks.user.getMetadata.mockResolvedValue([{ key: UserMetadataKey.Preferences, value: { autoStack } }] as any);

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AutoStackService));
    setPreferences({ enabled: true });
    mocks.stack.getAutoStackCandidates.mockResolvedValue([]);
    mocks.stack.create.mockResolvedValue({ id: 'stack-id' } as any);
    mocks.stack.addAssets.mockResolvedValue();
    mocks.stack.update.mockResolvedValue({} as any);
    mocks.stack.resetAutoStacked.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleAutoStack', () => {
    it('should stack a raw file with its JPEG, the JPEG as cover', async () => {
      mocks.stack.getForAutoStack.mockResolvedValue(target('CAM00074.ARW') as any);
      mocks.stack.getAutoStackCandidates.mockResolvedValue([candidate('CAM00074.JPG')] as any);

      await expect(sut.handleAutoStack({ id: 'CAM00074.ARW' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.getAutoStackCandidates).toHaveBeenCalledWith({
        ownerId: 'user-id',
        assetId: 'CAM00074.ARW',
        autoStackId: null,
        nameKeys: ['cam00074', 'cam00074-edited', 'cam00074 (edited)'],
        similar: undefined,
      });
      expect(mocks.stack.create).toHaveBeenCalledWith({ ownerId: 'user-id', isAutomatic: true }, [
        'CAM00074.JPG',
        'CAM00074.ARW',
      ]);
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith(
        { assetId: 'CAM00074.JPG', autoStackedAt: expect.any(Date) },
        { assetId: 'CAM00074.ARW', autoStackedAt: expect.any(Date) },
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('StackCreate', { stackId: 'stack-id', userId: 'user-id' });
    });

    it('should do nothing when auto stacking is off', async () => {
      setPreferences({ enabled: false });
      mocks.stack.getForAutoStack.mockResolvedValue(target('CAM00074.ARW') as any);
      await expect(sut.handleAutoStack({ id: 'CAM00074.ARW' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.getAutoStackCandidates).not.toHaveBeenCalled();
    });

    it('should not ask for what the preferences leave out', async () => {
      setPreferences({ enabled: true, burst: false, rawJpeg: false, edited: false, similar: false });
      mocks.stack.getForAutoStack.mockResolvedValue(target('CAM00074.ARW') as any);
      await expect(sut.handleAutoStack({ id: 'CAM00074.ARW' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.getAutoStackCandidates).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'in a stack', overrides: { stackId: 'stack' } },
      { name: 'taken out of a stack auto stacking made', overrides: { autoStackedAt: new Date() } },
      { name: 'trashed', overrides: { deletedAt: new Date() } },
      { name: 'hidden (a live photo video)', overrides: { visibility: AssetVisibility.Hidden } },
      { name: 'locked', overrides: { visibility: AssetVisibility.Locked } },
    ])('should leave an asset $name alone', async ({ overrides }) => {
      mocks.stack.getForAutoStack.mockResolvedValue(target('CAM00074.ARW', overrides) as any);
      await expect(sut.handleAutoStack({ id: 'CAM00074.ARW' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('should leave out a match taken out of a stack auto stacking made', async () => {
      mocks.stack.getForAutoStack.mockResolvedValue(target('CAM00074.ARW') as any);
      mocks.stack.getAutoStackCandidates.mockResolvedValue([
        candidate('CAM00074.JPG', { autoStackedAt: new Date() }),
      ] as any);
      await expect(sut.handleAutoStack({ id: 'CAM00074.ARW' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('should ask for similar photos within the window, with its embedding', async () => {
      setPreferences({ enabled: true, similar: true, maxSeconds: 5 });
      mocks.stack.getForAutoStack.mockResolvedValue(target('IMG_5571.HEIC') as any);
      mocks.stack.getAutoStackCandidates.mockResolvedValue([
        candidate('IMG_5573.HEIC', { distance: 0.0141, fileCreatedAt: new Date(taken.getTime() + 4000) }),
        candidate('IMG_5590.HEIC', { distance: 0.05, fileCreatedAt: new Date(taken.getTime() + 2000) }),
      ] as any);

      await sut.handleAutoStack({ id: 'IMG_5571.HEIC' });

      expect(mocks.stack.getAutoStackCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          similar: {
            from: new Date(taken.getTime() - 5000),
            to: new Date(taken.getTime() + 5000),
            embedding: '[0.1]',
          },
        }),
      );
      expect(mocks.stack.create).toHaveBeenCalledWith(expect.anything(), ['IMG_5571.HEIC', 'IMG_5573.HEIC']);
    });

    it('should join the stack of a match, and never merge two stacks', async () => {
      mocks.stack.getForAutoStack.mockResolvedValue(target('IMG_E1234.HEIC') as any);
      mocks.stack.getAutoStackCandidates.mockResolvedValue([
        candidate('IMG_1234.HEIC', { stackId: 'burst-stack', isAutomatic: true, primaryAssetId: 'IMG_1234.HEIC' }),
        candidate('IMG_1234.DNG', { stackId: 'other-stack', isAutomatic: false, primaryAssetId: 'x' }),
      ] as any);

      await expect(sut.handleAutoStack({ id: 'IMG_E1234.HEIC' })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.addAssets).toHaveBeenCalledWith('burst-stack', ['IMG_E1234.HEIC']);
      // the edited copy becomes the cover of a stack auto stacking made
      expect(mocks.stack.update).toHaveBeenCalledWith('burst-stack', { primaryAssetId: 'IMG_E1234.HEIC' });
      expect(mocks.stack.create).not.toHaveBeenCalled();
      expect(mocks.event.emit).toHaveBeenCalledWith('StackUpdate', { stackId: 'burst-stack', userId: 'user-id' });
    });

    it('should not change the cover of a stack someone made', async () => {
      mocks.stack.getForAutoStack.mockResolvedValue(target('IMG_E1234.HEIC') as any);
      mocks.stack.getAutoStackCandidates.mockResolvedValue([
        candidate('IMG_1234.HEIC', { stackId: 'mine', isAutomatic: false, primaryAssetId: 'IMG_1234.HEIC' }),
      ] as any);

      await sut.handleAutoStack({ id: 'IMG_E1234.HEIC' });

      expect(mocks.stack.addAssets).toHaveBeenCalledWith('mine', ['IMG_E1234.HEIC']);
      expect(mocks.stack.update).not.toHaveBeenCalled();
    });

    it('should stack the photos of a burst', async () => {
      mocks.stack.getForAutoStack.mockResolvedValue(target('IMG_1001.HEIC', { autoStackId: 'b' }) as any);
      mocks.stack.getAutoStackCandidates.mockResolvedValue([
        candidate('IMG_1002.HEIC', { autoStackId: 'b' }),
        candidate('IMG_1003.HEIC', { autoStackId: 'b' }),
      ] as any);

      await sut.handleAutoStack({ id: 'IMG_1001.HEIC' });

      expect(mocks.stack.getAutoStackCandidates).toHaveBeenCalledWith(expect.objectContaining({ autoStackId: 'b' }));
      expect(mocks.stack.create).toHaveBeenCalledWith(expect.anything(), [
        'IMG_1001.HEIC',
        'IMG_1002.HEIC',
        'IMG_1003.HEIC',
      ]);
    });
  });

  describe('handleQueueAll', () => {
    it('should queue the assets of the users who turned it on', async () => {
      mocks.user.getList.mockResolvedValue([UserFactory.create({ id: 'on' }), UserFactory.create({ id: 'off' })]);
      mocks.user.getMetadata.mockImplementation((id) =>
        Promise.resolve([{ key: UserMetadataKey.Preferences, value: { autoStack: { enabled: id === 'on' } } }] as any),
      );
      mocks.stack.streamForAutoStack.mockReturnValue(makeStream([{ id: 'asset-1' }, { id: 'asset-2' }]));

      await expect(sut.handleQueueAll({ force: false })).resolves.toBe(JobStatus.Success);

      expect(mocks.stack.streamForAutoStack).toHaveBeenCalledWith(['on'], false);
      expect(mocks.stack.resetAutoStacked).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetAutoStack, data: { id: 'asset-1' } },
        { name: JobName.AssetAutoStack, data: { id: 'asset-2' } },
      ]);
    });

    it('should forget what was taken out of stacks when forced, for one user', async () => {
      mocks.stack.streamForAutoStack.mockReturnValue(makeStream([]));
      await sut.handleQueueAll({ force: true, userId: 'user-id' });
      expect(mocks.user.getList).not.toHaveBeenCalled();
      expect(mocks.stack.resetAutoStacked).toHaveBeenCalledWith('user-id');
      expect(mocks.stack.streamForAutoStack).toHaveBeenCalledWith(['user-id'], true);
    });

    it('should skip when nobody turned it on', async () => {
      setPreferences({ enabled: false });
      await expect(sut.handleQueueAll({ userId: 'user-id' })).resolves.toBe(JobStatus.Skipped);
    });
  });

  describe('removeAll', () => {
    it('should remove the stacks auto stacking made for the user', async () => {
      mocks.stack.removeAutomatic.mockResolvedValue(3);
      const auth = factory.auth();
      await expect(sut.removeAll(auth)).resolves.toEqual({ count: 3 });
      expect(mocks.stack.removeAutomatic).toHaveBeenCalledWith(auth.user.id);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_stack_update', auth.user.id);
    });
  });
});
