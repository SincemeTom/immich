import type { SynologyLibraryAsset, SynologyUserAsset } from 'src/repositories/synology-album.repository.js';
import type { SynologyAccount } from 'src/types.js';
import { AlbumUserRole } from 'src/enum.js';
import { type AlbumUserAccess, toAlbumUserAccess } from 'src/utils/album-access.js';

/** Why connecting to Synology, or logging in to it, failed */
export enum SynologyErrorReason {
  /** no answer: a wrong address, the NAS is off, or a firewall */
  Unreachable = 'unreachable',
  /** the HTTPS certificate was not trusted */
  Certificate = 'certificate',
  /** something answered, but not the Synology Web API */
  NotSynology = 'notSynology',
  /** DSM answered, but Synology Photos is not installed, or the account may not use it */
  NoPhotos = 'noPhotos',
  WrongPassword = 'wrongPassword',
  Disabled = 'disabled',
  /** the account may not log in from here (DSM's application privileges) */
  Denied = 'denied',
  /** the account has 2-step verification on: a code is needed, once, after which this server is trusted */
  OtpRequired = 'otpRequired',
  OtpWrong = 'otpWrong',
  /** DSM requires the account to set up 2-step verification first */
  OtpEnforced = 'otpEnforced',
  /** DSM blocked this server's IP address, after too many failed logins */
  Blocked = 'blocked',
  PasswordExpired = 'passwordExpired',
  /** another Immich user bound the same Synology account */
  AlreadyBound = 'alreadyBound',
  /** the password could not be kept in, or read from, the macOS Keychain */
  Keychain = 'keychain',
  Other = 'other',
}

/** Why a Synology album, or a photo of it, is in the list of those the last sync could not match */
export enum SynologyUnmatchedReason {
  /** the photo was not found in its owner's library */
  NotFound = 'notFound',
  /** found by name, size and time more than once in its owner's library: one was taken */
  Ambiguous = 'ambiguous',
  /** its owner is not in Immich yet */
  OwnerWaiting = 'ownerWaiting',
  /** none of the album's photos were found: not created */
  AlbumEmpty = 'albumEmpty',
  /** Synology did not list the album's photos: left as it was */
  AlbumFailed = 'albumFailed',
}

/** SYNO.API.Auth login's error codes (DSM Login Web API Guide) */
const AUTH_ERRORS: Record<number, SynologyErrorReason> = {
  400: SynologyErrorReason.WrongPassword,
  401: SynologyErrorReason.Disabled,
  402: SynologyErrorReason.Denied,
  403: SynologyErrorReason.OtpRequired,
  404: SynologyErrorReason.OtpWrong,
  406: SynologyErrorReason.OtpEnforced,
  407: SynologyErrorReason.Blocked,
  408: SynologyErrorReason.PasswordExpired,
  409: SynologyErrorReason.PasswordExpired,
  410: SynologyErrorReason.PasswordExpired,
};

export const getAuthErrorReason = (code?: number) =>
  (code === undefined ? undefined : AUTH_ERRORS[code]) ?? SynologyErrorReason.Other;

/**
 * The address of a Synology, as its origin: `https://nas.example.com:5001`. A path is dropped, as one pasted from the
 * browser's address bar may have one; the Web API is always at /webapi. HTTPS is assumed without a scheme.
 */
export const toSynologyUrl = (value: string): string | undefined => {
  const text = value.trim();
  if (!text) {
    return;
  }

  try {
    const url = new URL(/^[a-z][\d+.a-z-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return;
    }
    return url.origin;
  } catch {
    return;
  }
};

/** Node's TLS errors that mean the certificate was not trusted, rather than that nothing answered */
const CERTIFICATE_ERRORS = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** plain HTTP to the HTTPS port, or the other way round */
const PROTOCOL_ERRORS = new Set(['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'HPE_INVALID_CONSTANT']);

export const getConnectionErrorReason = (code?: string) => {
  if (code && CERTIFICATE_ERRORS.has(code)) {
    return SynologyErrorReason.Certificate;
  }
  if (code && PROTOCOL_ERRORS.has(code)) {
    return SynologyErrorReason.NotSynology;
  }
  return SynologyErrorReason.Unreachable;
};

export class SynologyError extends Error {
  constructor(
    public reason: SynologyErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/** the time of day the albums are synced at, unless the user set another */
export const SYNOLOGY_SYNC_TIME = '03:00';

const SYNC_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isSynologySyncTime = (value: string) => SYNC_TIME.test(value);

/** The last time, at or before now, the time of day came round: in the server's own time zone */
export const getLastScheduled = (time: string, now: Date) => {
  const [, hours, minutes] = SYNC_TIME.exec(time) ?? SYNC_TIME.exec(SYNOLOGY_SYNC_TIME)!;
  const date = new Date(now);
  date.setHours(Number(hours), Number(minutes), 0, 0);
  if (date > now) {
    date.setDate(date.getDate() - 1);
  }
  return date;
};

export const getNextScheduled = (time: string, now: Date) => {
  const date = getLastScheduled(time, now);
  date.setDate(date.getDate() + 1);
  return date;
};

/**
 * Whether the account's daily sync is due: its time came round since it was bound, its schedule changed, and a sync
 * was last asked for. A server that was off then syncs once when it is back.
 */
export const isSynologySyncDue = (account: SynologyAccount, now: Date) => {
  if (account.autoSync === false) {
    return false;
  }

  const scheduled = getLastScheduled(account.syncTime ?? SYNOLOGY_SYNC_TIME, now).getTime();
  const last = Math.max(
    ...[account.boundAt, account.scheduledAt, account.syncQueuedAt, account.lastSync?.startedAt]
      .filter((value): value is string => !!value)
      .map((value) => Date.parse(value) || 0),
  );
  return last < scheduled;
};

/**
 * What a member of a Synology album may do there, as an Immich album member: view only, download the originals too,
 * or add photos (and download). None for a role Synology may add
 */
export const toSynologyAlbumAccess = (role?: string): AlbumUserAccess | undefined => {
  switch (role) {
    case 'view': {
      return toAlbumUserAccess(AlbumUserRole.Viewer, { allowDownload: false });
    }
    case 'download': {
      return toAlbumUserAccess(AlbumUserRole.Viewer, { allowDownload: true });
    }
    case 'upload': {
      return toAlbumUserAccess(AlbumUserRole.Editor, { isManager: false });
    }
    default: {
      return;
    }
  }
};

/** Synology gives a photo's time as its local time encoded as UTC, as Immich's localDateTime: in seconds */
const SAME_TIME = 1;

/**
 * Another user's photos, by file name, to find a photo they added to a Synology album among when its path cannot be
 * read: the one of the same name (ignoring case), size and time, to the second as Synology rounds it
 */
export class SynologyNameIndex {
  private byName = new Map<string, SynologyUserAsset[]>();

  add(asset: SynologyUserAsset) {
    const name = asset.originalFileName.normalize('NFC').toLowerCase();
    const list = this.byName.get(name);
    if (list) {
      list.push(asset);
    } else {
      this.byName.set(name, [asset]);
    }
  }

  /**
   * The photo, and how many were the same: of several, the one already in the album, then one online, of an external
   * library, at the shortest path. They are copies of the same file, as name, size and time are the same
   */
  find(item: { filename: string; filesize?: number; time?: number }, preferred?: Set<string>) {
    const candidates = (this.byName.get(item.filename.normalize('NFC').toLowerCase()) ?? []).filter(
      (asset) =>
        (!item.filesize || asset.fileSizeInByte === item.filesize) &&
        (item.time === undefined || Math.abs(asset.localDateTime.getTime() / 1000 - item.time) <= SAME_TIME),
    );

    candidates.sort(
      (a, b) =>
        Number(!!preferred?.has(b.id)) - Number(!!preferred?.has(a.id)) ||
        Number(a.isOffline) - Number(b.isOffline) ||
        Number(!a.libraryId) - Number(!b.libraryId) ||
        a.originalPath.length - b.originalPath.length ||
        a.originalPath.localeCompare(b.originalPath),
    );
    return { asset: candidates[0] as SynologyUserAsset | undefined, count: candidates.length };
  }
}

/**
 * The path of a Synology Photos item from its folder's, relative to the Photos folder the folders are in: folder
 * `/2023/Trip` and file `a.jpg` are `2023/Trip/a.jpg`. NFC, as Synology and macOS may write the same name differently
 */
export const toSynologyPath = (folder: string, filename: string) =>
  [...folder.split('/').filter(Boolean), filename].join('/').normalize('NFC');

type IndexedAsset = { asset: SynologyLibraryAsset; path: string; lowerPath: string };

/**
 * The photos of the user's external libraries, by file name, to find a Synology Photos item among: the one whose path
 * ends in the item's path, the Photos folder being mounted wherever the library has it
 */
export class SynologyPathIndex {
  private byName = new Map<string, IndexedAsset[]>();

  add(asset: SynologyLibraryAsset) {
    const path = asset.originalPath.normalize('NFC');
    const lowerPath = path.toLowerCase();
    const name = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
    const list = this.byName.get(name);
    const entry = { asset, path, lowerPath };
    if (list) {
      list.push(entry);
    } else {
      this.byName.set(name, [entry]);
    }
  }

  get size() {
    let size = 0;
    for (const list of this.byName.values()) {
      size += list.length;
    }
    return size;
  }

  /**
   * The photo at the Synology path, matched at a folder boundary: exactly, or else ignoring case, as a share may be
   * mounted case-insensitively. Of several, one of the same size, online, at the shortest path. A photo directly in
   * the Photos folder is only taken when its size is the same, as only its name is to go by
   */
  find(relativePath: string, size?: number): SynologyLibraryAsset | undefined {
    const lowerRelative = relativePath.toLowerCase();
    const candidates = this.byName.get(lowerRelative.slice(lowerRelative.lastIndexOf('/') + 1));
    if (!candidates) {
      return;
    }

    const suffix = `/${relativePath}`;
    let found = candidates.filter(({ path }) => path.endsWith(suffix));
    if (found.length === 0) {
      const lowerSuffix = `/${lowerRelative}`;
      found = candidates.filter(({ lowerPath }) => lowerPath.endsWith(lowerSuffix));
    }

    const sameSize = (entry: IndexedAsset) => !!size && entry.asset.fileSizeInByte === size;
    if (!relativePath.includes('/') && size) {
      found = found.filter((entry) => sameSize(entry) || entry.asset.fileSizeInByte === null);
    }

    found.sort(
      (a, b) =>
        Number(sameSize(b)) - Number(sameSize(a)) ||
        Number(a.asset.isOffline) - Number(b.asset.isOffline) ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path),
    );
    return found[0]?.asset;
  }
}
