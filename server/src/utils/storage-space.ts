import type { NetworkShare } from 'src/utils/network-share.js';

/** A share's space when the minute check last read it, after reading the share's folder answered */
export type NetworkShareSpace = { total: number; used: number; available: number };

/**
 * What the microservices worker's minute check read: where the shares to be mounted are mounted (their real paths),
 * and the space of those that answered, by id
 */
export type NetworkShareSpaces = {
  checkedAt: string;
  mountPaths: Record<string, string>;
  shares: Record<string, NetworkShareSpace>;
};

/** a check older than this is not taken: the microservices worker has stopped, or its checks hang */
export const SHARE_SPACE_MAX_AGE = 3 * 60 * 1000;
/** two volumes of the same NAS whose free space differs by less than this, and whose sizes are the same, are one */
const SAME_VOLUME_BYTES = 1024 ** 3;
const SAME_VOLUME_RATIO = 0.001;

export const LOCAL_VOLUME = 'local';

export enum StorageVolumeKind {
  Local = 'local',
  NetworkShare = 'networkShare',
}

export enum StorageVolumeStatus {
  /** counted in the server's storage */
  Counted = 'counted',
  /** the same volume as one counted: two shares of one NAS volume, or the share the library is kept on */
  SameVolume = 'sameVolume',
  /** to be mounted, but not mounted, or not answering, at the last check */
  Offline = 'offline',
  /** unmounted by hand */
  Disabled = 'disabled',
  /** the server's storage is set not to count the network shares */
  Excluded = 'excluded',
}

export type StorageVolume = {
  id: string;
  kind: StorageVolumeKind;
  name: string;
  /** the folder for this Mac's disk; host:/export for a share */
  source: string;
  path: string;
  status: StorageVolumeStatus;
  /** the volume it is the same as, when so */
  sameAs?: string;
  totalBytes?: number;
  usedBytes?: number;
  availableBytes?: number;
};

export type StorageSummary = {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** shares to be mounted that could not be counted, as they were not mounted or did not answer */
  notCounted: number;
  /** when the shares' space was read */
  checkedAt?: string;
  volumes: StorageVolume[];
};

type LocalDisk = { path: string; total: number; free: number; available: number };
type Share = Pick<NetworkShare, 'id' | 'name' | 'host' | 'exportPath' | 'enabled'> & { mountPath: string };

export const isWithinFolder = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);

const isSameVolume = (a: NetworkShareSpace, b: NetworkShareSpace) =>
  a.total === b.total &&
  Math.abs(a.available - b.available) <= Math.max(SAME_VOLUME_BYTES, a.total * SAME_VOLUME_RATIO);

/**
 * The server's storage: this Mac's disk the library is on, and the network shares that answered the last check,
 * each volume once. A NAS volume shared twice (the homes of two users, say) is the same size, with the same space
 * free, from the same host: it is counted once. A share the library itself is kept on is the local disk already.
 */
export const summarizeStorage = ({
  local,
  shares,
  spaces,
  includeShares,
  now = new Date(),
}: {
  local: LocalDisk;
  shares: Share[];
  spaces?: NetworkShareSpaces;
  includeShares: boolean;
  now?: Date;
}): StorageSummary => {
  const localVolume: StorageVolume = {
    id: LOCAL_VOLUME,
    kind: StorageVolumeKind.Local,
    name: '',
    source: local.path,
    path: local.path,
    status: StorageVolumeStatus.Counted,
    totalBytes: local.total,
    usedBytes: local.total - local.free,
    availableBytes: local.available,
  };
  const volumes: StorageVolume[] = [localVolume];
  const fresh = !!spaces && now.getTime() - Date.parse(spaces.checkedAt) <= SHARE_SPACE_MAX_AGE;
  const counted: Array<{ share: Share; space: NetworkShareSpace }> = [];
  let notCounted = 0;

  for (const share of shares) {
    const space = fresh ? spaces.shares[share.id] : undefined;
    const volume: StorageVolume = {
      id: share.id,
      kind: StorageVolumeKind.NetworkShare,
      name: share.name,
      source: `${share.host}:${share.exportPath}`,
      path: share.mountPath,
      status: StorageVolumeStatus.Counted,
      totalBytes: space?.total,
      usedBytes: space?.used,
      availableBytes: space?.available,
    };
    volumes.push(volume);

    if (!share.enabled) {
      volume.status = StorageVolumeStatus.Disabled;
    } else if (!space) {
      volume.status = StorageVolumeStatus.Offline;
      notCounted += includeShares ? 1 : 0;
    } else if (!includeShares) {
      volume.status = StorageVolumeStatus.Excluded;
    } else if (isWithinFolder(local.path, share.mountPath)) {
      volume.status = StorageVolumeStatus.SameVolume;
      volume.sameAs = LOCAL_VOLUME;
    } else {
      const same = counted.find((other) => other.share.host === share.host && isSameVolume(other.space, space));
      if (same) {
        volume.status = StorageVolumeStatus.SameVolume;
        volume.sameAs = same.share.id;
      } else {
        counted.push({ share, space });
      }
    }
  }

  const sum = (key: keyof NetworkShareSpace) => counted.reduce((total, { space }) => total + space[key], 0);
  return {
    totalBytes: local.total + sum('total'),
    usedBytes: local.total - local.free + sum('used'),
    availableBytes: local.available + sum('available'),
    notCounted,
    checkedAt: spaces?.checkedAt,
    volumes,
  };
};
