import {
  LOCAL_VOLUME,
  SHARE_SPACE_MAX_AGE,
  StorageVolumeStatus,
  isWithinFolder,
  summarizeStorage,
} from 'src/utils/storage-space.js';

const GiB = 1024 ** 3;
const now = new Date('2026-11-04T12:00:00.000Z');
const local = { path: '/Users/me/Immich/library', total: 500 * GiB, free: 200 * GiB, available: 190 * GiB };
const share = (id: string, overrides: { host?: string; enabled?: boolean; mountPath?: string } = {}) => ({
  id,
  name: id.toUpperCase(),
  host: overrides.host ?? 'nas',
  exportPath: `/volume1/${id}`,
  enabled: overrides.enabled ?? true,
  mountPath: overrides.mountPath ?? `/mounts/${id}`,
});
const space = (total: number, available: number) => ({
  total: total * GiB,
  used: (total - available) * GiB,
  available: available * GiB,
});
const spaces = (shares: Record<string, ReturnType<typeof space>>, checkedAt = now) => ({
  checkedAt: checkedAt.toISOString(),
  mountPaths: {},
  shares,
});

describe('summarizeStorage', () => {
  it('should be the local disk alone without shares', () => {
    expect(summarizeStorage({ local, shares: [], includeShares: true, now })).toEqual({
      totalBytes: 500 * GiB,
      usedBytes: 300 * GiB,
      availableBytes: 190 * GiB,
      notCounted: 0,
      checkedAt: undefined,
      volumes: [
        {
          id: LOCAL_VOLUME,
          kind: 'local',
          name: '',
          source: local.path,
          path: local.path,
          status: StorageVolumeStatus.Counted,
          totalBytes: 500 * GiB,
          usedBytes: 300 * GiB,
          availableBytes: 190 * GiB,
        },
      ],
    });
  });

  it('should add the shares that answered', () => {
    const summary = summarizeStorage({
      local,
      shares: [share('a'), share('b', { host: 'nas2' })],
      spaces: spaces({ a: space(8000, 3000), b: space(4000, 1000) }),
      includeShares: true,
      now,
    });

    expect(summary).toMatchObject({
      totalBytes: 12_500 * GiB,
      usedBytes: 8300 * GiB,
      availableBytes: 4190 * GiB,
      notCounted: 0,
    });
    expect(summary.volumes.map(({ status }) => status)).toEqual([
      StorageVolumeStatus.Counted,
      StorageVolumeStatus.Counted,
      StorageVolumeStatus.Counted,
    ]);
  });

  it('should count a volume of a NAS shared twice once', () => {
    const summary = summarizeStorage({
      local,
      // free space read a little apart, as photos were written between
      shares: [share('a'), share('b'), share('c', { host: 'other' })],
      spaces: spaces({
        a: space(8000, 3000),
        b: { ...space(8000, 3000), available: 3000 * GiB - 1000 },
        c: space(8000, 3000),
      }),
      includeShares: true,
      now,
    });

    expect(summary.totalBytes).toBe(16_500 * GiB);
    expect(summary.volumes[2]).toMatchObject({ id: 'b', status: StorageVolumeStatus.SameVolume, sameAs: 'a' });
    // the same size on another NAS is another volume
    expect(summary.volumes[3]).toMatchObject({ id: 'c', status: StorageVolumeStatus.Counted });
  });

  it('should count two volumes of a NAS whose free space differs', () => {
    const summary = summarizeStorage({
      local,
      shares: [share('a'), share('b')],
      spaces: spaces({ a: space(8000, 3000), b: space(8000, 2000) }),
      includeShares: true,
      now,
    });

    expect(summary.totalBytes).toBe(16_500 * GiB);
  });

  it('should not count a share the library is kept on twice', () => {
    const summary = summarizeStorage({
      local: { ...local, path: '/mounts/a/immich/library' },
      shares: [share('a')],
      spaces: spaces({ a: space(8000, 3000) }),
      includeShares: true,
      now,
    });

    expect(summary.totalBytes).toBe(500 * GiB);
    expect(summary.volumes[1]).toMatchObject({ status: StorageVolumeStatus.SameVolume, sameAs: LOCAL_VOLUME });
  });

  it('should leave out, and count, the shares that did not answer; leave out those unmounted by hand', () => {
    const summary = summarizeStorage({
      local,
      shares: [share('a'), share('b'), share('c', { enabled: false })],
      spaces: spaces({ a: space(8000, 3000) }),
      includeShares: true,
      now,
    });

    expect(summary).toMatchObject({ totalBytes: 8500 * GiB, notCounted: 1 });
    expect(summary.volumes[2]).toMatchObject({ id: 'b', status: StorageVolumeStatus.Offline, totalBytes: undefined });
    expect(summary.volumes[3]).toMatchObject({ id: 'c', status: StorageVolumeStatus.Disabled });
  });

  it('should not take a check too old: the worker that makes it has stopped', () => {
    const summary = summarizeStorage({
      local,
      shares: [share('a')],
      spaces: spaces({ a: space(8000, 3000) }, new Date(now.getTime() - SHARE_SPACE_MAX_AGE - 1)),
      includeShares: true,
      now,
    });

    expect(summary).toMatchObject({ totalBytes: 500 * GiB, notCounted: 1 });
    expect(summary.volumes[1].status).toBe(StorageVolumeStatus.Offline);
  });

  it('should show the shares, but not count them, when set not to', () => {
    const summary = summarizeStorage({
      local,
      shares: [share('a'), share('b')],
      spaces: spaces({ a: space(8000, 3000) }),
      includeShares: false,
      now,
    });

    expect(summary).toMatchObject({ totalBytes: 500 * GiB, notCounted: 0 });
    expect(summary.volumes[1]).toMatchObject({ status: StorageVolumeStatus.Excluded, totalBytes: 8000 * GiB });
    expect(summary.volumes[2].status).toBe(StorageVolumeStatus.Offline);
  });
});

describe('isWithinFolder', () => {
  it.each([
    { path: '/mounts/a', folder: '/mounts/a', within: true },
    { path: '/mounts/a/x', folder: '/mounts/a', within: true },
    { path: '/mounts/a/x', folder: '/mounts/a/', within: true },
    { path: '/mounts/ab', folder: '/mounts/a', within: false },
  ])('$path in $folder: $within', ({ path, folder, within }) => {
    expect(isWithinFolder(path, folder)).toBe(within);
  });
});
