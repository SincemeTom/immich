import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import {
  NetworkShareCreateDto,
  NetworkShareResponseDto,
  NetworkShareTestDto,
  NetworkShareTestResponseDto,
  NetworkShareUpdateDto,
} from 'src/dtos/network-share.dto.js';
import { BootstrapEventPriority, CronJob, ImmichWorker, JobName, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { handlePromiseError } from 'src/utils/misc.js';
import {
  NetworkShare,
  NetworkShareErrorReason,
  NetworkShareProtocol,
  NetworkShareStatus,
  classifyMountError,
  getNetworkShareMountPath,
  getNfsMountArgs,
  isNetworkSharesSupported,
  parseNfsMounts,
  runCommand,
  toShareFolder,
} from 'src/utils/network-share.js';

const MOUNT_TIMEOUT = 30_000;
const READ_TIMEOUT = 10_000;
const STAT_TIMEOUT = 5000;
const TEST_ENTRIES = 20;
/** checks in a row a mounted share must fail before it is mounted again: a NAS waking its disks takes a while */
const PROBE_FAILURES = 2;

type ShareError = { reason: NetworkShareErrorReason; message: string };
type MountResult = { success: true; entries: string[] } | ({ success: false } & ShareError);
type ProbeResult = { success: true } | { success: false; stale: boolean; message: string };

/**
 * Network shares the server mounts itself, natively on macOS, where a NAS folder would otherwise have to be mounted
 * by hand (Finder, /etc/fstab, autofs) before an external library can read it. The API worker adds, changes and
 * removes them; the microservices worker mounts them when it starts, and every minute mounts again any that dropped.
 */
@Injectable()
export class NetworkShareService extends BaseService {
  private checking = false;
  /** failed checks in a row of mounted shares, by id */
  private probeFailures = new Map<string, number>();

  @OnEvent({
    name: 'AppBootstrap',
    priority: BootstrapEventPriority.NetworkShares,
    workers: [ImmichWorker.Microservices],
  })
  async onBootstrap() {
    if (!this.isSupported()) {
      return;
    }

    await this.handleMountAll();
    this.cronRepository.create({
      name: CronJob.NetworkShareCheck,
      expression: '* * * * *',
      onTick: () => handlePromiseError(this.handleMountAll(), this.logger),
      start: true,
    });
  }

  /** Mounts the shares that should be and aren't: at startup, after the NAS restarted, or the network dropped */
  async handleMountAll() {
    if (this.checking) {
      return;
    }

    this.checking = true;
    try {
      const shares = await this.getShares();
      const mounts = await this.getMounts();
      const errors = await this.getErrors();
      const available: Record<string, boolean> = {};
      let changed = false;
      for (const share of shares) {
        available[share.id] = false;
        if (!share.enabled) {
          continue;
        }

        const mountPath = await this.getMountPath(share);
        if (mounts.has(mountPath)) {
          const health = await this.checkMounted(share, mountPath);
          if (health !== 'remount') {
            available[share.id] = health === 'healthy';
            continue;
          }
        }

        const result = await this.mount(share);
        available[share.id] = result.success;
        const previous = errors[share.id];
        if (result.success) {
          this.logger.log(`Mounted network share ${share.name} (${share.host}:${share.exportPath})`);
          if (previous) {
            delete errors[share.id];
            changed = true;
          }
        } else if (previous?.message !== result.message) {
          // logged when it changes, not every minute the NAS is away
          this.logger.warn(`Could not mount network share ${share.name}: ${result.message}`);
          errors[share.id] = { reason: result.reason, message: result.message };
          changed = true;
        }
      }
      if (changed) {
        await this.systemMetadataRepository.set(SystemMetadataKey.NetworkShareErrors, { errors });
      }
      // folders kept on the shares (StorageLocationService) pause what uses them while they can't be
      await this.eventRepository.emit('NetworkSharesChecked', { available });
    } finally {
      this.checking = false;
    }
  }

  /**
   * Whether a mounted share works, or has stopped working and is to be unmounted and mounted again: its file handles
   * are stale (the NAS restarted, or its shared folder was recreated), or it hasn't answered in two checks (the NAS is
   * away; unmounted, reads fail at once rather than after NFS timeouts, and each check tries to mount it again).
   */
  private async checkMounted(share: NetworkShare, mountPath: string): Promise<'healthy' | 'failing' | 'remount'> {
    const probe = await this.probe(mountPath, READ_TIMEOUT);
    if (probe.success) {
      this.probeFailures.delete(share.id);
      return 'healthy';
    }

    const failures = (this.probeFailures.get(share.id) ?? 0) + 1;
    if (!probe.stale && failures < PROBE_FAILURES) {
      this.probeFailures.set(share.id, failures);
      return 'failing';
    }

    this.probeFailures.delete(share.id);
    this.logger.warn(`Network share ${share.name} stopped working (${probe.message}), mounting it again`);
    await this.unmount(mountPath, { force: true });
    return 'remount';
  }

  async getAll(): Promise<NetworkShareResponseDto[]> {
    this.requireSupport();
    const shares = await this.getShares();
    const mounts = await this.getMounts();
    const errors = await this.getErrors();
    const libraries = await this.libraryRepository.getAll();

    return Promise.all(
      shares.map(async (share) => {
        const mountPath = await this.getMountPath(share);
        const response: NetworkShareResponseDto = {
          ...this.map(share),
          mountPath,
          status: NetworkShareStatus.Unmounted,
          libraries: libraries
            .filter((library) => library.importPaths.some((path) => isWithin(path, mountPath)))
            .map((library) => library.name),
        };

        if (mounts.has(mountPath)) {
          // statfs, what df reads, may answer from a cache after the NAS has gone; reading the folder does not
          const probe = await this.probe(mountPath, STAT_TIMEOUT);
          if (probe.success) {
            response.status = NetworkShareStatus.Mounted;
            const space = await this.getSpace(mountPath);
            response.totalBytes = space?.total;
            response.availableBytes = space?.available;
          } else {
            response.status = NetworkShareStatus.Unresponsive;
            response.errorReason = NetworkShareErrorReason.Unreachable;
            response.message = probe.message;
          }
        } else if (share.enabled && errors[share.id]) {
          response.errorReason = errors[share.id].reason;
          response.message = errors[share.id].message;
        }

        return response;
      }),
    );
  }

  async get(id: string): Promise<NetworkShareResponseDto> {
    const shares = await this.getAll();
    const share = shares.find((share) => share.id === id);
    if (!share) {
      throw new NotFoundException('Network share not found');
    }
    return share;
  }

  /** Mounts it on a folder of its own, lists what it holds, and unmounts it: whether it can be added as it is */
  async test(dto: NetworkShareTestDto): Promise<NetworkShareTestResponseDto> {
    this.requireSupport();
    const share = { ...dto, folder: `.test-${this.cryptoRepository.randomUUID()}` };
    const mountPath = await this.getMountPath(share);
    try {
      const result = await this.mount(share);
      return result.success
        ? { success: true, entries: result.entries }
        : { success: false, errorReason: result.reason, message: result.message, entries: [] };
    } finally {
      await this.unmount(mountPath);
      await this.removeFolder(mountPath);
    }
  }

  async create(dto: NetworkShareCreateDto): Promise<NetworkShareResponseDto> {
    const location = this.requireSupport();
    const shares = await this.getShares();
    if (shares.some((share) => share.name === dto.name)) {
      throw new BadRequestException('A network share with this name already exists');
    }

    const folders = [...shares.map((share) => share.folder), ...(await this.listFolders(location))];
    const share: NetworkShare = {
      id: this.cryptoRepository.randomUUID(),
      name: dto.name,
      protocol: dto.protocol,
      host: dto.host,
      exportPath: dto.exportPath,
      nfsVersion: dto.nfsVersion,
      readOnly: dto.readOnly,
      folder: toShareFolder(dto.name, folders),
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    const result = await this.mount(share);
    if (!result.success) {
      const mountPath = await this.getMountPath(share);
      await this.unmount(mountPath);
      await this.removeFolder(mountPath);
      throw new BadRequestException(`Could not mount the share (${result.reason}): ${result.message}`);
    }

    await this.saveShares([...shares, share]);
    this.logger.log(`Added network share ${share.name} (${share.host}:${share.exportPath})`);
    return this.get(share.id);
  }

  async update(id: string, dto: NetworkShareUpdateDto): Promise<NetworkShareResponseDto> {
    this.requireSupport();
    const shares = await this.getShares();
    const share = this.findOrFail(shares, id);
    if (dto.name && dto.name !== share.name && shares.some((other) => other.name === dto.name)) {
      throw new BadRequestException('A network share with this name already exists');
    }

    const updated: NetworkShare = { ...share, ...dto };
    const uses = await this.getStorageLocationUses(id);
    if (updated.readOnly && !share.readOnly && uses.length > 0) {
      throw new BadRequestException(
        'The share keeps files Immich writes (Administration > Storage locations): it cannot be read-only',
      );
    }
    const reconnect = (['host', 'exportPath', 'nfsVersion', 'readOnly'] as const).some(
      (key) => updated[key] !== share[key],
    );
    await this.saveShares(shares.map((other) => (other.id === id ? updated : other)));
    if (reconnect) {
      const mountPath = await this.getMountPath(share);
      await this.unmount(mountPath);
      if (!updated.enabled) {
        await this.setLibrariesOffline(mountPath);
      } else if (await this.mountAndRecord(updated)) {
        await this.rescanLibraries(mountPath);
      }
    }

    return this.get(id);
  }

  /** Mounts it now, and keeps it mounted */
  async mountShare(id: string): Promise<NetworkShareResponseDto> {
    this.requireSupport();
    const shares = await this.getShares();
    const share = { ...this.findOrFail(shares, id), enabled: true };
    await this.saveShares(shares.map((other) => (other.id === id ? share : other)));
    const mounts = await this.getMounts();
    const mountPath = await this.getMountPath(share);
    if (!mounts.has(mountPath) && (await this.mountAndRecord(share))) {
      await this.rescanLibraries(mountPath);
    }
    return this.get(id);
  }

  /** Unmounts it, and leaves it so until it is mounted again: before the NAS is shut down, say */
  async unmountShare(id: string): Promise<NetworkShareResponseDto> {
    this.requireSupport();
    const shares = await this.getShares();
    const share = { ...this.findOrFail(shares, id), enabled: false };
    await this.saveShares(shares.map((other) => (other.id === id ? share : other)));
    const mountPath = await this.getMountPath(share);
    const result = await this.unmount(mountPath);
    if (!result.success) {
      throw new BadRequestException(`Could not unmount the share: ${result.message}`);
    }
    await this.setLibrariesOffline(mountPath);
    return this.get(id);
  }

  /** The external libraries that import from a share's mount point */
  private async getLibrariesOn(mountPath: string) {
    const libraries = await this.libraryRepository.getAll();
    return libraries.filter((library) => library.importPaths.some((path) => isWithin(path, mountPath)));
  }

  /**
   * Its libraries' files are offline while the share is unmounted on purpose: the web UI says so, and asks for the
   * share rather than failing to load an original. They stay in the timeline, with their thumbnails, and are not
   * trashed (macos/verification/m1-delete-cleanup.md); mounting it again brings them back.
   */
  private async setLibrariesOffline(mountPath: string) {
    for (const library of await this.getLibrariesOn(mountPath)) {
      await this.assetRepository.updateByLibraryId(library.id, { isOffline: true });
      this.logger.log(`Files of external library ${library.name} are offline while its share is unmounted`);
    }
  }

  /** A scan of its libraries' files, which finds the ones that were offline there again */
  private async rescanLibraries(mountPath: string) {
    const libraries = await this.getLibrariesOn(mountPath);
    await this.jobRepository.queueAll(
      libraries.map((library) => ({ name: JobName.LibrarySyncAssetsQueueAll, data: { id: library.id } })),
    );
  }

  async delete(id: string): Promise<void> {
    this.requireSupport();
    const shares = await this.getShares();
    const share = this.findOrFail(shares, id);
    const mountPath = await this.getMountPath(share);
    const libraries = await this.getLibrariesOn(mountPath);
    if (libraries.length > 0) {
      throw new BadRequestException(
        `The share is used by external libraries: ${libraries.map((library) => library.name).join(', ')}. Remove their import paths on it first.`,
      );
    }
    const uses = await this.getStorageLocationUses(id);
    if (uses.length > 0) {
      throw new BadRequestException(
        `The share keeps files Immich stores (${uses.join(', ')}). Move them elsewhere in Administration > Storage locations first.`,
      );
    }

    const result = await this.unmount(mountPath);
    if (!result.success) {
      throw new BadRequestException(`Could not unmount the share: ${result.message}`);
    }
    await this.removeFolder(mountPath);
    await this.saveShares(shares.filter((other) => other.id !== id));
    this.logger.log(`Removed network share ${share.name}`);
  }

  private isSupported() {
    return isNetworkSharesSupported(this.configRepository.getEnv().storage.networkSharesLocation);
  }

  private requireSupport(): string {
    const location = this.configRepository.getEnv().storage.networkSharesLocation;
    if (!isNetworkSharesSupported(location)) {
      throw new BadRequestException('Network shares are only available when Immich runs natively on macOS');
    }
    return location;
  }

  private findOrFail(shares: NetworkShare[], id: string) {
    const share = shares.find((share) => share.id === id);
    if (!share) {
      throw new NotFoundException('Network share not found');
    }
    return share;
  }

  private map(share: NetworkShare) {
    const { id, name, protocol, host, exportPath, nfsVersion, readOnly, enabled } = share;
    return { id, name, protocol, host, exportPath, nfsVersion, readOnly, enabled };
  }

  /** What Immich keeps on a share: "thumbs", "user:<id>" (StorageLocationService) */
  private async getStorageLocationUses(id: string) {
    const locations = await this.systemMetadataRepository.get(SystemMetadataKey.StorageLocations);
    return [
      ...Object.entries(locations?.folders ?? {}).filter(([, location]) => location?.shareId === id),
      ...Object.entries(locations?.users ?? {})
        .filter(([, location]) => location.shareId === id)
        .map(([userId]) => [`user:${userId}`]),
    ].map(([key]) => key);
  }

  private async getShares(): Promise<NetworkShare[]> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.NetworkShares);
    return value?.shares ?? [];
  }

  private async saveShares(shares: NetworkShare[]) {
    await this.systemMetadataRepository.set(SystemMetadataKey.NetworkShares, { shares });
  }

  private async getErrors(): Promise<Record<string, ShareError>> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.NetworkShareErrors);
    return value?.errors ?? {};
  }

  private async mountAndRecord(share: NetworkShare): Promise<boolean> {
    const result = await this.mount(share);
    const errors = await this.getErrors();
    if (result.success) {
      delete errors[share.id];
    } else {
      errors[share.id] = { reason: result.reason, message: result.message };
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.NetworkShareErrors, { errors });
    return result.success;
  }

  /** The mount point as `mount` lists it: the location's real path, which /tmp, say, is not */
  private async getMountPath(share: Pick<NetworkShare, 'folder'>) {
    const location = this.requireSupport();
    this.storageRepository.mkdirSync(location);
    return getNetworkShareMountPath(await this.storageRepository.realpath(location), share);
  }

  private async getMounts() {
    const result = await this.run('/sbin/mount', ['-t', 'nfs'], STAT_TIMEOUT);
    return parseNfsMounts(result.stdout);
  }

  private async listFolders(location: string) {
    this.storageRepository.mkdirSync(location);
    return this.storageRepository.readdir(location);
  }

  /** Mounts it, then reads its top level, which is when macOS asks whether the server may read network volumes */
  private async mount(share: Omit<NetworkShare, 'id' | 'name' | 'enabled' | 'createdAt'>): Promise<MountResult> {
    if (share.protocol !== NetworkShareProtocol.Nfs) {
      return {
        success: false,
        reason: NetworkShareErrorReason.Other,
        message: `Unsupported protocol ${share.protocol}`,
      };
    }

    const mountPath = await this.getMountPath(share);
    this.storageRepository.mkdirSync(mountPath);
    const mounts = await this.getMounts();
    if (!mounts.has(mountPath)) {
      // read-only while nothing is mounted on it, so that a file meant for the NAS can never be written to the Mac
      // instead, where it would fill the disk and then be hidden by the share; mounted, the share's own permissions
      // apply. Never the share's: changing them on a mounted one would change the NAS folder's.
      await this.storageRepository.chmod(mountPath, 0o555);
    }
    const { networkSharesNfsPort } = this.configRepository.getEnv().storage;
    const mounted = await this.run(
      '/sbin/mount_nfs',
      getNfsMountArgs(share, mountPath, networkSharesNfsPort),
      MOUNT_TIMEOUT,
    );
    if (mounted.code !== 0) {
      const message = mounted.timedOut
        ? `No answer from ${share.host} within ${MOUNT_TIMEOUT / 1000} s`
        : (mounted.stderr || mounted.stdout).trim() || `mount_nfs exited with ${mounted.code}`;
      return {
        success: false,
        reason: mounted.timedOut ? NetworkShareErrorReason.Unreachable : classifyMountError(message),
        message,
      };
    }

    const listed = await this.run('/bin/ls', ['-1A', mountPath], READ_TIMEOUT);
    if (listed.timedOut) {
      return {
        success: false,
        reason: NetworkShareErrorReason.MacPermission,
        message: 'Mounted, but reading it is waiting for macOS: allow "node" to access network volumes on the Mac',
      };
    }
    if (listed.code !== 0) {
      const message = listed.stderr.trim() || `ls exited with ${listed.code}`;
      return { success: false, reason: classifyMountError(message), message };
    }

    const entries = listed.stdout
      .split('\n')
      .filter((entry) => entry && !entry.startsWith('.'))
      .slice(0, TEST_ENTRIES);
    return { success: true, entries };
  }

  /** Whether a mounted share answers: reading its top level */
  private async probe(mountPath: string, timeout: number): Promise<ProbeResult> {
    const result = await this.run('/bin/ls', ['-1A', mountPath], timeout);
    if (result.code === 0) {
      return { success: true };
    }
    const message = result.timedOut
      ? `No answer within ${timeout / 1000} s`
      : result.stderr.trim() || `ls exited with ${result.code}`;
    return { success: false, stale: /stale nfs file handle/i.test(message), message };
  }

  private async unmount(mountPath: string, { force = false } = {}): Promise<{ success: boolean; message?: string }> {
    const mounts = await this.getMounts();
    if (!mounts.has(mountPath)) {
      return { success: true };
    }

    let result = await this.run('/sbin/umount', force ? ['-f', mountPath] : [mountPath], MOUNT_TIMEOUT);
    if (result.code !== 0 && !force) {
      // a NAS that is gone, or a file the server holds open on it
      result = await this.run('/sbin/umount', ['-f', mountPath], MOUNT_TIMEOUT);
    }
    return result.code === 0 ? { success: true } : { success: false, message: (result.stderr || 'timed out').trim() };
  }

  /** Only an empty folder, that nothing is mounted on: never what a mounted share holds */
  private async removeFolder(mountPath: string) {
    const mounts = await this.getMounts();
    if (mounts.has(mountPath)) {
      return;
    }
    try {
      await this.storageRepository.rmdir(mountPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn(`Could not remove ${mountPath}: ${error}`);
      }
    }
  }

  /** Size and free space, from df: which also tells whether the NAS answers */
  private async getSpace(mountPath: string) {
    const result = await this.run('/bin/df', ['-k', '-P', mountPath], STAT_TIMEOUT);
    // "host:/export 1024-blocks used available capacity% /mount/point", where the paths may hold spaces
    const match = result.code === 0 ? /\s(\d+)\s+\d+\s+(\d+)\s+\d+%\s/.exec(result.stdout) : null;
    if (!match) {
      return;
    }
    return { total: Number(match[1]) * 1024, available: Number(match[2]) * 1024 };
  }

  private run(command: string, args: string[], timeout: number) {
    return runCommand((cmd, cmdArgs) => this.processRepository.spawn(cmd, cmdArgs), command, args, timeout);
  }
}

const isWithin = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
