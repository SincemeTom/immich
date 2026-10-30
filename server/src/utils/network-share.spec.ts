import {
  NetworkShareErrorReason,
  NfsVersion,
  classifyMountError,
  getNfsMountArgs,
  isValidHost,
  parseNfsMounts,
  toShareFolder,
} from 'src/utils/network-share.js';

describe('network shares', () => {
  describe(toShareFolder.name, () => {
    it.each([
      { name: '群晖照片', folder: '群晖照片' },
      { name: 'NAS photos', folder: 'NAS photos' },
      { name: String.raw`a/b\c:d`, folder: 'a-b-c-d' },
      { name: '../..', folder: 'share' },
      { name: '  .hidden ', folder: 'hidden' },
      { name: 'x'.repeat(100), folder: 'x'.repeat(64) },
    ])('should name the folder of $name', ({ name, folder }) => {
      expect(toShareFolder(name, [])).toBe(folder);
    });

    it('should pick a folder not taken', () => {
      expect(toShareFolder('NAS', ['NAS', 'NAS-2'])).toBe('NAS-3');
    });
  });

  describe(isValidHost.name, () => {
    it.each(['192.168.1.10', 'nas.local', 'DS920', '[fe80::1]', 'my-nas.example.com'])('should take %s', (host) => {
      expect(isValidHost(host)).toBe(true);
    });

    it.each(['', '-nas', 'nas;rm -rf /', 'nas /x', '192.168.1.10:/volume1', 'fe80::1'])('should refuse %s', (host) => {
      expect(isValidHost(host)).toBe(false);
    });
  });

  describe(getNfsMountArgs.name, () => {
    it('should keep the options, the source and the mount point apart', () => {
      expect(
        getNfsMountArgs(
          { host: 'nas', exportPath: '/volume1/my photos', nfsVersion: NfsVersion.V3, readOnly: false },
          '/Users/me/Library/Application Support/Immich/mounts/NAS',
          12_049,
        ),
      ).toEqual([
        '-o',
        'soft,intr,timeo=10,retrans=5,deadtimeout=120,retrycnt=0,nfc,nobrowse,tcp,vers=3,port=12049,mountport=12049',
        'nas:/volume1/my photos',
        '/Users/me/Library/Application Support/Immich/mounts/NAS',
      ]);
    });
  });

  describe(parseNfsMounts.name, () => {
    it('should read mount points with spaces', () => {
      const output = [
        '192.168.1.10:/volume1/photo on /Users/me/Library/Application Support/Immich/mounts/NAS photos (nfs, nodev, nosuid, mounted by me)',
        'nas:/volume1/video on /Users/me/mnt/video (nfs, asynchronous)',
        '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      ].join('\n');
      expect(parseNfsMounts(output)).toEqual(
        new Map([
          ['/Users/me/Library/Application Support/Immich/mounts/NAS photos', '192.168.1.10:/volume1/photo'],
          ['/Users/me/mnt/video', 'nas:/volume1/video'],
        ]),
      );
    });
  });

  describe(classifyMountError.name, () => {
    it.each([
      ["mount_nfs: can't mount /volume1/photo from nas onto /x: Permission denied", NetworkShareErrorReason.Denied],
      ["mount_nfs: can't mount /volume1/photo from nas onto /x: Authentication error", NetworkShareErrorReason.Denied],
      [
        "mount_nfs: can't mount /volume1/x from nas onto /x: No such file or directory",
        NetworkShareErrorReason.NotFound,
      ],
      [
        "mount_nfs: can't resolve host: nas.invalid\nmount_nfs: can't mount /x from nas.invalid onto /x: No such file or directory",
        NetworkShareErrorReason.Unreachable,
      ],
      ["mount_nfs: can't mount / from 127.0.0.1 onto /x: Connection refused", NetworkShareErrorReason.Unreachable],
      [
        "mount_nfs: can't mount /volume1/photo from nas onto /x: Operation timed out",
        NetworkShareErrorReason.Unreachable,
      ],
      [
        "mount_nfs: can't mount /volume1/photo from nas onto /x: Connection refused",
        NetworkShareErrorReason.Unreachable,
      ],
      ["mount_nfs: can't resolve host nas.local", NetworkShareErrorReason.Unreachable],
      ['ls: /x: Operation not permitted', NetworkShareErrorReason.MacPermission],
      ['something else', NetworkShareErrorReason.Other],
    ])('should take "%s" for %s', (message, reason) => {
      expect(classifyMountError(message)).toBe(reason);
    });
  });
});
