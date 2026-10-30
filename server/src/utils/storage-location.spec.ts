import { QueueName, StorageFolder } from 'src/enum.js';
import {
  getDefaultLocationPath,
  getQueuesUsing,
  isIgnoredEntry,
  normalizeLocationPath,
  overlaps,
  resolveStorageLocations,
} from 'src/utils/storage-location.js';

describe('storage locations', () => {
  it.each([
    ['immich/thumbs', 'immich/thumbs'],
    ['/immich/thumbs/', 'immich/thumbs'],
    ['  照片/Immich ', '照片/Immich'],
    ['a//b/./c', 'a/b/c'],
    ['', null],
    ['/', null],
    ['.', null],
    ['../etc', null],
    ['a/../../b', null],
    ['a/../b', 'b'],
  ])('should take %j as %j', (path, expected) => {
    expect(normalizeLocationPath(path)).toBe(expected);
  });

  it('should resolve the locations on the shares they are on', () => {
    const shares = [{ id: 'nas', folder: 'NAS' }];
    expect(
      resolveStorageLocations('/mounts', shares, {
        folders: { thumbs: { shareId: 'nas', path: 'immich/thumbs' }, backups: { shareId: 'gone', path: 'x' } },
        users: { u1: { shareId: 'nas', path: 'me/Photos/Immich' } },
        pending: { thumbs: ['/data/thumbs'] },
      }),
    ).toEqual({
      folders: { thumbs: '/mounts/NAS/immich/thumbs' },
      users: { u1: '/mounts/NAS/me/Photos/Immich' },
      pending: { thumbs: ['/data/thumbs'] },
    });
    expect(resolveStorageLocations(undefined, shares, { folders: {}, users: {}, pending: {} }).folders).toEqual({});
  });

  it('should tell folders that are one, or hold one another, from neighbours', () => {
    expect(overlaps('/a/b', '/a/b')).toBe(true);
    expect(overlaps('/a/b', '/a/b/c')).toBe(true);
    expect(overlaps('/a/b/c', '/a/b')).toBe(true);
    expect(overlaps('/a/b', '/a/bc')).toBe(false);
  });

  it('should pause what reads or writes each folder', () => {
    expect(getQueuesUsing(StorageFolder.Thumbnails)).toContain(QueueName.ThumbnailGeneration);
    expect(getQueuesUsing(StorageFolder.Thumbnails)).not.toContain(QueueName.MetadataExtraction);
    expect(getQueuesUsing(StorageFolder.Backups)).toEqual([QueueName.BackupDatabase]);
    expect(getQueuesUsing('user:u1')).toEqual(
      expect.arrayContaining([QueueName.MetadataExtraction, QueueName.StorageTemplateMigration]),
    );
  });

  it('should take what a NAS or Finder leaves in a folder as empty', () => {
    expect(['.DS_Store', '@eaDir', '#recycle', '._x', '.immich'].every((entry) => isIgnoredEntry(entry))).toBe(true);
    expect(isIgnoredEntry('2024')).toBe(false);
  });

  it('should suggest folders of their own', () => {
    expect(getDefaultLocationPath({ folder: StorageFolder.EncodedVideo })).toBe('immich/encoded-video');
    expect(getDefaultLocationPath({ user: { email: 'me@example.com', storageLabel: null } })).toBe('me/Photos/Immich');
    expect(getDefaultLocationPath({ user: { email: 'me@example.com', storageLabel: 'petyr' } })).toBe(
      'petyr/Photos/Immich',
    );
  });
});
