import { AlbumUserRole } from 'src/enum.js';

/**
 * What a member of an album can do, beyond the role (which clients such as the mobile apps know as one of three):
 *
 * | access   | role   | can                                                                     |
 * |----------|--------|-------------------------------------------------------------------------|
 * | viewer   | viewer | see the photos (thumbnails, previews, videos), comment                  |
 * | download | viewer | and download the originals                                              |
 * | editor   | editor | and add photos, remove them                                             |
 * | manager  | editor | and manage the album as its owner: members, details, cover, shared links |
 * | owner    | owner  | and delete it                                                           |
 */
export type AlbumUserAccess = { role: AlbumUserRole; allowDownload: boolean; isManager: boolean };

/** The flags of a member as they are stored and returned: download for all but some viewers, managing for some editors */
export const toAlbumUserAccess = (
  role: AlbumUserRole,
  requested: { allowDownload?: boolean; isManager?: boolean },
  current?: AlbumUserAccess,
): AlbumUserAccess => {
  const keep = current?.role === role ? current : undefined;
  return {
    role,
    allowDownload: role === AlbumUserRole.Viewer ? (requested.allowDownload ?? keep?.allowDownload ?? false) : true,
    isManager: role === AlbumUserRole.Editor ? (requested.isManager ?? keep?.isManager ?? false) : false,
  };
};

/** As returned: an editor and the owner download; only an editor is a manager (the owner is more) */
export const effectiveAlbumUserAccess = ({ role, allowDownload, isManager }: AlbumUserAccess) => ({
  allowDownload: role !== AlbumUserRole.Viewer || allowDownload,
  isManager: role === AlbumUserRole.Editor && isManager,
});
