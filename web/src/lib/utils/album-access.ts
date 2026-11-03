import { AlbumUserRole, type AlbumResponseDto, type AlbumUserResponseDto } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';

/**
 * What a member of an album can do, from the least to the most (as the server's album-access):
 * a viewer sees the photos, a downloader also downloads the originals, an editor also adds and removes photos,
 * a manager also manages the album as its owner does (members, details, cover, shared links), the owner also deletes it.
 */
export enum AlbumAccess {
  Viewer = 'viewer',
  Downloader = 'downloader',
  Editor = 'editor',
  Manager = 'manager',
  Owner = 'owner',
}

type AlbumUserAccess = Pick<AlbumUserResponseDto, 'role' | 'allowDownload' | 'isManager'>;

/** A member's access changed */
export type AlbumUserUpdate = { albumId: string; userId: string } & AlbumUserAccess;

export const getAlbumUserAccess = ({ role, allowDownload, isManager }: AlbumUserAccess) => {
  switch (role) {
    case AlbumUserRole.Owner: {
      return AlbumAccess.Owner;
    }
    case AlbumUserRole.Editor: {
      return isManager ? AlbumAccess.Manager : AlbumAccess.Editor;
    }
    default: {
      return allowDownload ? AlbumAccess.Downloader : AlbumAccess.Viewer;
    }
  }
};

/** The role and flags the server is sent for an access (the owner is not one a member can be given) */
export const toAlbumUserAccess = (access: Exclude<AlbumAccess, AlbumAccess.Owner>): AlbumUserAccess => {
  switch (access) {
    case AlbumAccess.Manager: {
      return { role: AlbumUserRole.Editor, allowDownload: true, isManager: true };
    }
    case AlbumAccess.Editor: {
      return { role: AlbumUserRole.Editor, allowDownload: true, isManager: false };
    }
    case AlbumAccess.Downloader: {
      return { role: AlbumUserRole.Viewer, allowDownload: true, isManager: false };
    }
    case AlbumAccess.Viewer: {
      return { role: AlbumUserRole.Viewer, allowDownload: false, isManager: false };
    }
  }
};

const getMyAlbumUser = (album: AlbumResponseDto) =>
  album.albumUsers.find(({ user: { id } }) => id === authManager.user.id);

export const isAlbumOwner = (album: AlbumResponseDto) => album.albumUsers[0].user.id === authManager.user.id;

/** Can add photos to the album, and remove them */
export const isAlbumEditor = (album: AlbumResponseDto) =>
  isAlbumOwner(album) || getMyAlbumUser(album)?.role === AlbumUserRole.Editor;

/** Can manage the album: members, details, cover, shared links */
export const isAlbumManager = (album: AlbumResponseDto) => isAlbumOwner(album) || !!getMyAlbumUser(album)?.isManager;

/** Can download the originals of the album's photos */
export const canDownloadFromAlbum = (album: AlbumResponseDto) =>
  isAlbumOwner(album) || !!getMyAlbumUser(album)?.allowDownload;

let originalsRestricted = false;

/**
 * Set while an album is open whose originals the user cannot download: its photos are then shown from what the server
 * makes of them (full size, preview), not from the originals, which it refuses
 */
export const setAlbumOriginalsRestricted = (restricted: boolean) => {
  originalsRestricted = restricted;
};

/** The original of a photo can be loaded to show it: unless in such an album, and not the user's */
export const canLoadOriginal = (asset: { ownerId: string }) =>
  !originalsRestricted || (authManager.authenticated && asset.ownerId === authManager.user.id);
