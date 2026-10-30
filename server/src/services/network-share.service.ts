import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import {
  NetworkShareCreateDto,
  NetworkShareResponseDto,
  NetworkShareTestDto,
  NetworkShareTestResponseDto,
  NetworkShareUpdateDto,
} from 'src/dtos/network-share.dto.js';
import { BootstrapEventPriority, CronJob, ImmichWorker, SystemMetadataKey } from 'src/enum.js';
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

type ShareError = { reason: NetworkShareErrorReason; message: string };
type MountResult = { success: true; entries: string[] } | ({ success: false } & ShareError);

/**
 * Network shares the server mounts itself, natively on macOS, where a NAS folder would otherwise have to be mounted
 * by hand (Finder, /etc/fstab, autofs) before an external library can read it. The API worker adds, changes and
 * removes them; the microservices worker mounts them when it starts, and every minute mounts again any that dropped.
 */
@Injectable()
export class NetworkShareService extends BaseService {
  private checking = false;

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
      let changed = false;
      for (const share of shares) {
        if (!share.enabled || mounts.has(await this.getMountPath(share))) {
          continue;
        }

        const result = await this.mount(share);
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
    } finally {
      this.checking = false;
    }
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
          const space = await this.getSpace(mountPath);
          if (space) {
            response.status = NetworkShareStatus.Mounted;
            response.totalBytes = space.total;
            response.availableBytes = space.available;
          } else {
            response.status = NetworkShareStatus.Unresponsive;
            response.errorReason = NetworkShareErrorReason.Unreachable;
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
    const reconnect = (['host', 'exportPath', 'nfsVersion', 'readOnly'] as const).some(
      (key) => updated[key] !== share[key],
    );
    await this.saveShares(shares.map((other) => (other.id === id ? updated : other)));
    if (reconnect) {
      await this.unmount(await this.getMountPath(share));
      if (updated.enabled) {
        await this.mountAndRecord(updated);
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
    if (!mounts.has(await this.getMountPath(share))) {
      await this.mountAndRecord(share);
    }
    return this.get(id);
  }

  /** Unmounts it, and leaves it so until it is mounted again: before the NAS is shut down, say */
  async unmountShare(id: string): Promise<NetworkShareResponseDto> {
    this.requireSupport();
    const shares = await this.getShares();
    const share = { ...this.findOrFail(shares, id), enabled: false };
    await this.saveShares(shares.map((other) => (other.id === id ? share : other)));
    const result = await this.unmount(await this.getMountPath(share));
    if (!result.success) {
      throw new BadRequestException(`Could not unmount the share: ${result.message}`);
    }
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    this.requireSupport();
    const shares = await this.getShares();
    const share = this.findOrFail(shares, id);
    const mountPath = await this.getMountPath(share);
    const allLibraries = await this.libraryRepository.getAll();
    const libraries = allLibraries.filter((library) => library.importPaths.some((path) => isWithin(path, mountPath)));
    if (libraries.length > 0) {
      throw new BadRequestException(
        `The share is used by external libraries: ${libraries.map((library) => library.name).join(', ')}. Remove their import paths on it first.`,
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

  private async mountAndRecord(share: NetworkShare) {
    const result = await this.mount(share);
    const errors = await this.getErrors();
    if (result.success) {
      delete errors[share.id];
    } else {
      errors[share.id] = { reason: result.reason, message: result.message };
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.NetworkShareErrors, { errors });
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

  private async unmount(mountPath: string): Promise<{ success: boolean; message?: string }> {
    const mounts = await this.getMounts();
    if (!mounts.has(mountPath)) {
      return { success: true };
    }

    let result = await this.run('/sbin/umount', [mountPath], MOUNT_TIMEOUT);
    if (result.code !== 0) {
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
    const fields = result.code === 0 ? result.stdout.trim().split('\n').at(-1)?.split(/\s+/) : undefined;
    if (!fields || fields.length < 4) {
      return;
    }
    return { total: Number(fields[1]) * 1024, available: Number(fields[3]) * 1024 };
  }

  private run(command: string, args: string[], timeout: number) {
    return runCommand((cmd, cmdArgs) => this.processRepository.spawn(cmd, cmdArgs), command, args, timeout);
  }
}

const isWithin = (path: string, folder: string) =>
  path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
