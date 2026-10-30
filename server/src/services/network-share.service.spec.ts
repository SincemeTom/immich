import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CronJob, SystemMetadataKey } from 'src/enum.js';
import { NetworkShareService } from 'src/services/network-share.service.js';
import {
  NetworkShare,
  NetworkShareErrorReason,
  NetworkShareProtocol,
  NetworkShareStatus,
  NfsVersion,
} from 'src/utils/network-share.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const location = '/Users/me/Library/Application Support/Immich/mounts';

type Reply = { code?: number; stdout?: string; stderr?: string; hang?: boolean };

/** A child process that writes what it is given and exits, or never does */
const child = ({ code = 0, stdout = '', stderr = '', hang = false }: Reply) => {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  setImmediate(() => {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    if (!hang) {
      process.emit('close', code);
    }
  });
  return process;
};

const share = (overrides: Partial<NetworkShare> = {}): NetworkShare => ({
  id: 'share-id',
  name: 'NAS photos',
  protocol: NetworkShareProtocol.Nfs,
  host: '192.168.1.10',
  exportPath: '/volume1/photo',
  nfsVersion: NfsVersion.Auto,
  readOnly: false,
  folder: 'NAS photos',
  enabled: true,
  createdAt: '2026-10-30T00:00:00.000Z',
  ...overrides,
});

describe(NetworkShareService.name, () => {
  let sut: NetworkShareService;
  let mocks: ServiceMocks;
  let platform: PropertyDescriptor;
  /** what is mounted, by mount point; mount_nfs and umount change it */
  let mounted: Set<string>;
  /** replies by command; mount_nfs and ls replies fall back to success */
  let replies: Record<string, Reply>;
  let shares: NetworkShare[];

  const spawned = (command: string) =>
    mocks.process.spawn.mock.calls.filter((call) => call[0] === command).map((call) => call[1] as string[]);

  beforeAll(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(NetworkShareService));
    mounted = new Set();
    replies = {};
    shares = [];
    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ storage: { ignoreMountCheckErrors: false, networkSharesLocation: location } }),
    );
    mocks.storage.realpath.mockImplementation((path) => Promise.resolve(path));
    mocks.storage.readdir.mockResolvedValue([]);
    mocks.library.getAll.mockResolvedValue([]);
    mocks.crypto.randomUUID.mockReturnValue('new-id');
    mocks.systemMetadata.get.mockImplementation(
      (key) => Promise.resolve(key === SystemMetadataKey.NetworkShares ? { shares } : undefined) as any,
    );
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      if (key === SystemMetadataKey.NetworkShares) {
        shares = (value as { shares: NetworkShare[] }).shares;
      }
      return Promise.resolve();
    });
    mocks.process.spawn.mockImplementation(((command: string, args: string[]) => {
      switch (command) {
        case '/sbin/mount': {
          return child({
            stdout: [...mounted]
              .map((path) => `192.168.1.10:/volume1/photo on ${path} (nfs, nodev, nosuid, mounted by me)`)
              .join('\n'),
          });
        }
        case '/sbin/mount_nfs': {
          const reply = replies.mount_nfs ?? {};
          if (!reply.code && !reply.hang) {
            mounted.add(args.at(-1)!);
          }
          return child(reply);
        }
        case '/sbin/umount': {
          mounted.delete(args.at(-1)!);
          return child({});
        }
        case '/bin/ls': {
          return child(replies.ls ?? { stdout: '.DS_Store\n2025\n2026\n' });
        }
        case '/bin/df': {
          return child(
            replies.df ?? {
              stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\n192.168.1.10:/volume1/photo 1000 400 600 40% ${args.at(-1)}\n`,
            },
          );
        }
      }
      throw new Error(`unexpected command ${command}`);
    }) as any);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('where the server cannot mount shares', () => {
    beforeEach(() => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { ignoreMountCheckErrors: false } }));
    });

    it('should refuse the API', async () => {
      await expect(sut.getAll()).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.test({
          protocol: NetworkShareProtocol.Nfs,
          host: 'nas',
          exportPath: '/x',
          nfsVersion: NfsVersion.Auto,
          readOnly: false,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should not mount anything when it starts', async () => {
      await sut.onBootstrap();
      expect(mocks.process.spawn).not.toHaveBeenCalled();
      expect(mocks.cron.create).not.toHaveBeenCalled();
    });
  });

  describe('test', () => {
    const dto = {
      protocol: NetworkShareProtocol.Nfs,
      host: '192.168.1.10',
      exportPath: '/volume1/photo',
      nfsVersion: NfsVersion.Auto,
      readOnly: false,
    };

    it('should mount it on a folder of its own, list it, unmount it and remove the folder', async () => {
      await expect(sut.test(dto)).resolves.toEqual({ success: true, entries: ['2025', '2026'] });

      const mountPath = `${location}/.test-new-id`;
      expect(spawned('/sbin/mount_nfs')).toEqual([
        [
          '-o',
          'soft,intr,timeo=10,retrans=5,deadtimeout=120,retrycnt=0,nfc,nobrowse,tcp',
          '192.168.1.10:/volume1/photo',
          mountPath,
        ],
      ]);
      expect(spawned('/sbin/umount')).toEqual([[mountPath]]);
      expect(mocks.storage.rmdir).toHaveBeenCalledWith(mountPath);
      expect(mounted.size).toBe(0);
    });

    it.each([
      {
        stderr: "mount_nfs: can't mount /volume1/photo from 192.168.1.10 onto /x: Permission denied",
        reason: NetworkShareErrorReason.Denied,
      },
      {
        stderr: "mount_nfs: can't mount /volume1/nope from 192.168.1.10 onto /x: No such file or directory",
        reason: NetworkShareErrorReason.NotFound,
      },
      {
        stderr: "mount_nfs: can't mount /volume1/photo from 192.168.1.99 onto /x: Operation timed out",
        reason: NetworkShareErrorReason.Unreachable,
      },
      { stderr: "mount_nfs: can't resolve host nas.local", reason: NetworkShareErrorReason.Unreachable },
    ])('should explain a refusal: $reason', async ({ stderr, reason }) => {
      replies.mount_nfs = { code: 1, stderr };
      await expect(sut.test(dto)).resolves.toEqual({
        success: false,
        errorReason: reason,
        message: stderr,
        entries: [],
      });
      expect(mocks.storage.rmdir).toHaveBeenCalledWith(`${location}/.test-new-id`);
    });

    it('should tell when macOS denies reading network volumes', async () => {
      replies.ls = { code: 1, stderr: `ls: ${location}/.test-new-id: Operation not permitted` };
      await expect(sut.test(dto)).resolves.toMatchObject({
        success: false,
        errorReason: NetworkShareErrorReason.MacPermission,
      });
      expect(mounted.size).toBe(0);
    });

    it('should tell when reading waits for someone to allow it on the Mac', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        replies.ls = { hang: true };
        const result = sut.test(dto);
        await vi.waitFor(() => expect(spawned('/bin/ls')).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(result).resolves.toMatchObject({
          success: false,
          errorReason: NetworkShareErrorReason.MacPermission,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should pass the options asked for', async () => {
      await sut.test({ ...dto, nfsVersion: NfsVersion.V4, readOnly: true });
      expect(spawned('/sbin/mount_nfs')[0][1]).toBe(
        'soft,intr,timeo=10,retrans=5,deadtimeout=120,retrycnt=0,nfc,nobrowse,tcp,vers=4,rdonly',
      );
    });
  });

  describe('create', () => {
    const dto = {
      name: 'NAS photos',
      protocol: NetworkShareProtocol.Nfs,
      host: '192.168.1.10',
      exportPath: '/volume1/photo',
      nfsVersion: NfsVersion.Auto,
      readOnly: false,
    };

    it('should mount and keep it', async () => {
      const response = await sut.create(dto);

      expect(shares).toEqual([
        expect.objectContaining({ id: 'new-id', name: 'NAS photos', folder: 'NAS photos', enabled: true }),
      ]);
      expect(response).toMatchObject({
        id: 'new-id',
        mountPath: `${location}/NAS photos`,
        status: NetworkShareStatus.Mounted,
        totalBytes: 1000 * 1024,
        availableBytes: 600 * 1024,
        libraries: [],
      });
    });

    it('should not keep one that does not mount', async () => {
      replies.mount_nfs = { code: 1, stderr: 'Permission denied' };
      await expect(sut.create(dto)).rejects.toThrow('Could not mount the share (denied): Permission denied');
      expect(shares).toEqual([]);
      expect(mocks.storage.rmdir).toHaveBeenCalledWith(`${location}/NAS photos`);
    });

    it('should refuse a name in use, and give another a folder of its own', async () => {
      shares = [share()];
      mounted.add(`${location}/NAS photos`);
      await expect(sut.create(dto)).rejects.toThrow('already exists');

      mocks.crypto.randomUUID.mockReturnValue('second-id');
      mocks.storage.readdir.mockResolvedValue(['NAS photos', 'NAS-photos']);
      await sut.create({ ...dto, name: 'NAS/photos' });
      expect(shares[1].folder).toBe('NAS-photos-2');
    });
  });

  describe('getAll', () => {
    it('should report each share, and the libraries that read it', async () => {
      shares = [
        share(),
        share({ id: 'off', name: 'Off', folder: 'Off', enabled: false }),
        share({ id: 'down', name: 'Down', folder: 'Down' }),
      ];
      mounted.add(`${location}/NAS photos`);
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          key === SystemMetadataKey.NetworkShares
            ? { shares }
            : { errors: { down: { reason: NetworkShareErrorReason.Unreachable, message: 'Operation timed out' } } },
        ),
      );
      mocks.library.getAll.mockResolvedValue([
        factory.library({ name: 'Family', importPaths: [`${location}/NAS photos/family`] }),
        factory.library({ name: 'Elsewhere', importPaths: [`${location}/NAS photos-old`] }),
      ]);

      const [mountedShare, off, down] = await sut.getAll();

      expect(mountedShare).toMatchObject({ status: NetworkShareStatus.Mounted, libraries: ['Family'] });
      expect(off).toMatchObject({ status: NetworkShareStatus.Unmounted, enabled: false });
      expect(off.errorReason).toBeUndefined();
      expect(down).toMatchObject({
        status: NetworkShareStatus.Unmounted,
        errorReason: NetworkShareErrorReason.Unreachable,
        message: 'Operation timed out',
      });
    });

    it('should report a mounted share that does not answer', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        shares = [share()];
        mounted.add(`${location}/NAS photos`);
        replies.df = { hang: true };
        const result = sut.getAll();
        await vi.waitFor(() => expect(spawned('/bin/df')).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toEqual([expect.objectContaining({ status: NetworkShareStatus.Unresponsive })]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('handleMountAll', () => {
    it('should mount the shares that should be and are not', async () => {
      shares = [share(), share({ id: 'off', folder: 'Off', enabled: false }), share({ id: 'up', folder: 'Up' })];
      mounted.add(`${location}/Up`);

      await sut.handleMountAll();

      expect(spawned('/sbin/mount_nfs').map((args) => args.at(-1))).toEqual([`${location}/NAS photos`]);
    });

    it('should record a failure once, and clear it when the share is back', async () => {
      shares = [share()];
      let errors = {};
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(key === SystemMetadataKey.NetworkShares ? { shares } : { errors }),
      );
      mocks.systemMetadata.set.mockImplementation((key, value) => {
        if (key === SystemMetadataKey.NetworkShareErrors) {
          errors = (value as { errors: object }).errors;
        }
        return Promise.resolve();
      });

      replies.mount_nfs = { code: 1, stderr: 'Operation timed out' };
      await sut.handleMountAll();
      await sut.handleMountAll();
      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
      expect(errors).toEqual({
        'share-id': { reason: NetworkShareErrorReason.Unreachable, message: 'Operation timed out' },
      });

      delete replies.mount_nfs;
      await sut.handleMountAll();
      expect(errors).toEqual({});
    });

    it('should mount at startup, and check every minute', async () => {
      shares = [share()];
      mocks.cron.create.mockReturnValue(void 0);
      await sut.onBootstrap();
      expect(mounted).toEqual(new Set([`${location}/NAS photos`]));
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: CronJob.NetworkShareCheck, expression: '* * * * *', start: true }),
      );
    });
  });

  describe('mountShare and unmountShare', () => {
    it('should unmount it and keep it so, then mount it and keep it so', async () => {
      shares = [share()];
      mounted.add(`${location}/NAS photos`);

      await expect(sut.unmountShare('share-id')).resolves.toMatchObject({
        enabled: false,
        status: NetworkShareStatus.Unmounted,
      });
      await sut.handleMountAll();
      expect(spawned('/sbin/mount_nfs')).toHaveLength(0);

      await expect(sut.mountShare('share-id')).resolves.toMatchObject({
        enabled: true,
        status: NetworkShareStatus.Mounted,
      });
    });

    it('should fail for a share that does not exist', async () => {
      await expect(sut.mountShare('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    it('should mount it again when how it is mounted changes', async () => {
      shares = [share()];
      mounted.add(`${location}/NAS photos`);

      await sut.update('share-id', { host: '192.168.1.11' });

      expect(spawned('/sbin/umount')).toEqual([[`${location}/NAS photos`]]);
      expect(spawned('/sbin/mount_nfs')[0][2]).toBe('192.168.1.11:/volume1/photo');
      expect(shares[0]).toMatchObject({ host: '192.168.1.11', folder: 'NAS photos' });
    });

    it('should only rename it, keeping its folder', async () => {
      shares = [share()];
      await sut.update('share-id', { name: 'Photos' });
      expect(spawned('/sbin/mount_nfs')).toHaveLength(0);
      expect(shares[0]).toMatchObject({ name: 'Photos', folder: 'NAS photos' });
    });
  });

  describe('delete', () => {
    it('should refuse while a library imports from it', async () => {
      shares = [share()];
      mocks.library.getAll.mockResolvedValue([
        factory.library({ name: 'Family', importPaths: [`${location}/NAS photos`] }),
      ]);
      await expect(sut.delete('share-id')).rejects.toThrow('used by external libraries: Family');
      expect(shares).toHaveLength(1);
    });

    it('should unmount it, remove its folder, and forget it', async () => {
      shares = [share()];
      mounted.add(`${location}/NAS photos`);

      await sut.delete('share-id');

      expect(mounted.size).toBe(0);
      expect(mocks.storage.rmdir).toHaveBeenCalledWith(`${location}/NAS photos`);
      expect(shares).toEqual([]);
    });

    it('should never remove the folder of a share still mounted', async () => {
      shares = [share()];
      mounted.add(`${location}/NAS photos`);
      mocks.process.spawn.mockImplementation(((command: string) =>
        command === '/sbin/mount'
          ? child({ stdout: `nas:/x on ${location}/NAS photos (nfs, nodev)` })
          : child({ code: 1, stderr: 'Resource busy' })) as any);

      await expect(sut.delete('share-id')).rejects.toThrow('Could not unmount the share: Resource busy');
      expect(mocks.storage.rmdir).not.toHaveBeenCalled();
      expect(shares).toHaveLength(1);
    });
  });
});
