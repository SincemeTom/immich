import { AlbumUserRole, getAssetInfo, type AlbumUserResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { vitest } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getAssetActions, handleDownloadAsset } from '$lib/services/asset.service';
import { setSharedLink } from '$lib/utils';
import { getFormatter } from '$lib/utils/i18n';
import { albumFactory } from '@test-data/factories/album-factory';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vitest.mock('@immich/ui', () => ({
  toastManager: {
    primary: vitest.fn(),
  },
}));

vitest.mock('$lib/utils/i18n', () => ({
  getFormatter: vitest.fn(),
  getPreferredLocale: vitest.fn(),
}));

vitest.mock('@immich/sdk');

vitest.mock('$lib/utils', async () => {
  const originalModule = await vitest.importActual('$lib/utils');
  return {
    ...originalModule,
    sleep: vitest.fn(),
  };
});

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: {} } as never,
  };
});

describe('AssetService', () => {
  describe('getAssetActions', () => {
    beforeEach(() => {
      authManager.setPreferences(preferencesFactory.build());
    });

    it('should allow shared link downloads if the user owns the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = userAdminFactory.build({ id: ownerId });
      const asset = assetFactory.build({ ownerId });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });

    it('should not allow shared link downloads if the user does not own the asset and shared link downloads are disabled', () => {
      const ownerId = 'owner';
      const user = userAdminFactory.build({ id: 'non-owner' });
      const asset = assetFactory.build({ ownerId });
      authManager.setUser(user);
      setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(false);
    });

    it('should allow shared link downloads if shared link downloads are enabled regardless of user', () => {
      const asset = assetFactory.build();
      setSharedLink(sharedLinkFactory.build({ allowDownload: true }));
      const assetActions = getAssetActions(() => '', asset);
      expect(assetActions.SharedLinkDownload.$if?.()).toStrictEqual(true);
    });

    describe('in a shared album', () => {
      const owner = userAdminFactory.build({ id: 'album-owner' });
      const member = userAdminFactory.build({ id: 'member' });
      const albumWith = (access: Partial<AlbumUserResponseDto>) =>
        albumFactory.build({
          albumUsers: [
            { user: owner, role: AlbumUserRole.Owner, allowDownload: true, isManager: false },
            { user: member, role: AlbumUserRole.Viewer, allowDownload: false, isManager: false, ...access },
          ],
        });

      beforeEach(() => {
        authManager.setUser(member);
      });

      it('should not let a viewer download the photos of others', () => {
        const actions = getAssetActions(() => '', assetFactory.build({ ownerId: owner.id }), albumWith({}));
        expect(actions.Download.$if?.()).toBe(false);
        expect(actions.DownloadOriginal.$if?.()).toBe(false);
        expect(actions.RemoveFromAlbum.$if?.()).toBe(false);
      });

      it('should let a viewer allowed to download them', () => {
        const actions = getAssetActions(
          () => '',
          assetFactory.build({ ownerId: owner.id }),
          albumWith({ allowDownload: true }),
        );
        expect(actions.Download.$if?.()).toBe(true);
      });

      it('should let a member download their own photos', () => {
        const actions = getAssetActions(() => '', assetFactory.build({ ownerId: member.id }), albumWith({}));
        expect(actions.Download.$if?.()).toBe(true);
      });

      it('should let an editor remove their own photos only', () => {
        const album = albumWith({ role: AlbumUserRole.Editor, allowDownload: true });
        expect(
          getAssetActions(() => '', assetFactory.build({ ownerId: member.id }), album).RemoveFromAlbum.$if?.(),
        ).toBe(true);
        expect(
          getAssetActions(() => '', assetFactory.build({ ownerId: owner.id }), album).RemoveFromAlbum.$if?.(),
        ).toBe(false);
      });

      it('should let a manager remove any photo', () => {
        const album = albumWith({ role: AlbumUserRole.Editor, allowDownload: true, isManager: true });
        expect(
          getAssetActions(() => '', assetFactory.build({ ownerId: owner.id }), album).RemoveFromAlbum.$if?.(),
        ).toBe(true);
      });
    });
  });

  describe('handleDownloadAsset', () => {
    it('should use the asset originalFileName when showing toasts', async () => {
      const $t = vitest.fn().mockReturnValue('formatter');
      vitest.mocked(getFormatter).mockResolvedValue($t);
      const asset = assetFactory.build({ originalFileName: 'asset.heic' });
      await handleDownloadAsset(asset, { edited: false });
      expect($t).toHaveBeenNthCalledWith(1, 'downloading_asset_filename', { values: { filename: 'asset.heic' } });
      expect(toastManager.primary).toHaveBeenCalledWith('formatter');
    });

    it('should use the motion asset originalFileName when showing toasts', async () => {
      const $t = vitest.fn().mockReturnValue('formatter');
      vitest.mocked(getFormatter).mockResolvedValue($t);
      const motionAsset = assetFactory.build({ originalFileName: 'asset.mov' });
      vitest.mocked(getAssetInfo).mockResolvedValue(motionAsset);
      const asset = assetFactory.build({ originalFileName: 'asset.heic', livePhotoVideoId: '1' });
      await handleDownloadAsset(asset, { edited: false });
      expect($t).toHaveBeenNthCalledWith(1, 'downloading_asset_filename', { values: { filename: 'asset.heic' } });
      expect($t).toHaveBeenNthCalledWith(2, 'downloading_asset_filename', { values: { filename: 'asset-motion.mov' } });
      expect(toastManager.primary).toHaveBeenCalledWith('formatter');
    });
  });
});
