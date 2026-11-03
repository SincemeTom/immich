import { AlbumUserRole } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import {
  AlbumAccess,
  canDownloadFromAlbum,
  canLoadOriginal,
  getAlbumUserAccess,
  isAlbumEditor,
  isAlbumManager,
  isAlbumOwner,
  setAlbumOriginalsRestricted,
  toAlbumUserAccess,
} from '$lib/utils/album-access';
import { albumFactory } from '@test-data/factories/album-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

describe('album access', () => {
  const owner = userAdminFactory.build({ id: 'album-owner' });
  const member = userAdminFactory.build({ id: 'member' });

  const albumWith = (access: Exclude<AlbumAccess, AlbumAccess.Owner>) =>
    albumFactory.build({
      albumUsers: [
        { user: owner, role: AlbumUserRole.Owner, allowDownload: true, isManager: false },
        { user: member, ...toAlbumUserAccess(access) },
      ],
    });

  afterEach(() => {
    setAlbumOriginalsRestricted(false);
  });

  it('should round-trip each access a member can be given', () => {
    for (const access of [
      AlbumAccess.Viewer,
      AlbumAccess.Downloader,
      AlbumAccess.Editor,
      AlbumAccess.Manager,
    ] as const) {
      expect(getAlbumUserAccess(toAlbumUserAccess(access))).toBe(access);
    }
    expect(getAlbumUserAccess({ role: AlbumUserRole.Owner, allowDownload: true, isManager: false })).toBe(
      AlbumAccess.Owner,
    );
  });

  it.each([
    { access: AlbumAccess.Viewer, download: false, edit: false, manage: false },
    { access: AlbumAccess.Downloader, download: true, edit: false, manage: false },
    { access: AlbumAccess.Editor, download: true, edit: true, manage: false },
    { access: AlbumAccess.Manager, download: true, edit: true, manage: true },
  ])('should tell what a $access can do', ({ access, download, edit, manage }) => {
    authManager.setUser(member);
    const album = albumWith(access);

    expect(isAlbumOwner(album)).toBe(false);
    expect(canDownloadFromAlbum(album)).toBe(download);
    expect(isAlbumEditor(album)).toBe(edit);
    expect(isAlbumManager(album)).toBe(manage);
  });

  it('should let the owner do everything', () => {
    authManager.setUser(owner);
    const album = albumWith(AlbumAccess.Viewer);

    expect(isAlbumOwner(album)).toBe(true);
    expect(canDownloadFromAlbum(album)).toBe(true);
    expect(isAlbumEditor(album)).toBe(true);
    expect(isAlbumManager(album)).toBe(true);
  });

  it('should not load the originals of others while restricted', () => {
    authManager.setUser(member);
    authManager.setPreferences(preferencesFactory.build());

    expect(canLoadOriginal({ ownerId: owner.id })).toBe(true);
    setAlbumOriginalsRestricted(true);
    expect(canLoadOriginal({ ownerId: owner.id })).toBe(false);
    expect(canLoadOriginal({ ownerId: member.id })).toBe(true);
  });
});
