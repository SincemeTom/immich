import { isAbsolute, join, normalize } from 'node:path';
import { QueueName, StorageFolder } from 'src/enum.js';
import { NetworkShare, getNetworkShareMountPath } from 'src/utils/network-share.js';

/** The folders of the media location that may be kept on a network share instead; upload and profile stay local */
export const RelocatableFolders = [
  StorageFolder.Thumbnails,
  StorageFolder.EncodedVideo,
  StorageFolder.Backups,
] as const;
export type RelocatableFolder = (typeof RelocatableFolders)[number];

/** A folder on a network share, as stored: the share, and the path under the folder it is mounted on */
export interface StorageLocation {
  shareId: string;
  path: string;
}

/** Under SystemMetadataKey.StorageLocations */
export interface StorageLocations {
  /** where a folder of the media location is kept, when it is not the media location itself */
  folders: Partial<Record<RelocatableFolder, StorageLocation>>;
  /** where a user's originals are kept, in place of <media>/library/<label or id>, by user id */
  users: Record<string, StorageLocation>;
  /**
   * The folders files are still to be moved out of, after a location changed: absolute paths, by what they held.
   * Emptied as the move finishes.
   */
  pending: Partial<Record<RelocatableFolder, string[]>>;
}

/** Under SystemMetadataKey.StorageLocationState: what the microservices worker last found, which the API reports */
export interface StorageLocationState {
  /** locations that could not be used, by key ("thumbs", "user:<id>"), with why */
  unavailable: Record<string, string>;
  /** the queues paused because of it, which are resumed when every location is back */
  pausedQueues: QueueName[];
  /** files left to move, by folder, while a move runs */
  migration?: Partial<Record<RelocatableFolder, { moved: number; remaining: number; failed: number }>>;
  checkedAt?: string;
}

/** Absolute paths, resolved from the locations and the shares' mount points */
export interface ResolvedStorageLocations {
  folders: Partial<Record<RelocatableFolder, string>>;
  users: Record<string, string>;
  /** folders files are still being moved out of: what was a folder's location before */
  pending: Partial<Record<RelocatableFolder, string[]>>;
}

export const emptyStorageLocations = (): StorageLocations => ({ folders: {}, users: {}, pending: {} });

export const MARKER_FILE = '.immich';

/** A path under a share: relative, without "..", trimmed of slashes */
export const normalizeLocationPath = (path: string) => {
  const trimmed = path.trim().replaceAll(/^\/+|\/+$/g, '');
  if (!trimmed || isAbsolute(trimmed)) {
    return null;
  }
  const normalized = normalize(trimmed);
  if (normalized === '.' || normalized.split('/').includes('..') || normalized.includes('\0')) {
    return null;
  }
  return normalized.normalize('NFC');
};

export const resolveStorageLocation = (
  mountRoot: string,
  shares: Pick<NetworkShare, 'id' | 'folder'>[],
  location: StorageLocation,
) => {
  const share = shares.find((share) => share.id === location.shareId);
  return share ? join(getNetworkShareMountPath(mountRoot, share), location.path) : undefined;
};

export const resolveStorageLocations = (
  mountRoot: string | undefined,
  shares: Pick<NetworkShare, 'id' | 'folder'>[],
  locations: StorageLocations,
): ResolvedStorageLocations => {
  const resolved: ResolvedStorageLocations = { folders: {}, users: {}, pending: { ...locations.pending } };
  if (!mountRoot) {
    return resolved;
  }
  for (const folder of RelocatableFolders) {
    const location = locations.folders[folder];
    const path = location && resolveStorageLocation(mountRoot, shares, location);
    if (path) {
      resolved.folders[folder] = path;
    }
  }
  for (const [userId, location] of Object.entries(locations.users)) {
    const path = resolveStorageLocation(mountRoot, shares, location);
    if (path) {
      resolved.users[userId] = path;
    }
  }
  return resolved;
};

export const isWithin = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);

/** Whether two folders are one, or one holds the other */
export const overlaps = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);

export const locationKey = (target: { folder: RelocatableFolder } | { userId: string }) =>
  'folder' in target ? target.folder : `user:${target.userId}`;

/**
 * The queues whose jobs read or write a location's files: paused while it can't be used, so that they wait for the
 * NAS instead of failing, or making thumbnails of nothing
 */
export const getQueuesUsing = (key: string): QueueName[] => {
  switch (key) {
    case StorageFolder.Thumbnails: {
      return [
        QueueName.ThumbnailGeneration,
        QueueName.SmartSearch,
        QueueName.FaceDetection,
        QueueName.Ocr,
        QueueName.Editor,
        QueueName.Migration,
        QueueName.BackgroundTask,
        QueueName.IntegrityCheck,
      ];
    }
    case StorageFolder.EncodedVideo: {
      return [QueueName.VideoConversion, QueueName.Migration, QueueName.BackgroundTask, QueueName.IntegrityCheck];
    }
    case StorageFolder.Backups: {
      return [QueueName.BackupDatabase];
    }
    default: {
      // a user's originals
      return [
        QueueName.MetadataExtraction,
        QueueName.StorageTemplateMigration,
        QueueName.Sidecar,
        QueueName.ThumbnailGeneration,
        QueueName.VideoConversion,
        QueueName.Editor,
        QueueName.Migration,
        QueueName.BackgroundTask,
        QueueName.IntegrityCheck,
      ];
    }
  }
};

/** What may already be in a folder a location is set to: what a NAS, Finder or Immich put there */
const IGNORED_ENTRIES = new Set(['.DS_Store', '@eaDir', '#recycle', '#snapshot', '.stfolder', MARKER_FILE]);
export const isIgnoredEntry = (entry: string) => IGNORED_ENTRIES.has(entry) || entry.startsWith('._');

/** A path a location suggests, by default: under the share, a folder of Immich's own */
export const getDefaultLocationPath = (
  target: { folder: RelocatableFolder } | { user: { email: string; storageLabel: string | null } },
) => {
  if ('folder' in target) {
    return `immich/${target.folder}`;
  }
  const name = target.user.storageLabel || target.user.email.split('@', 1)[0];
  return `${name}/Photos/Immich`;
};
