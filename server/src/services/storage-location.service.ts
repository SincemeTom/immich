import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { dirname, join, relative, resolve } from 'node:path';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  StorageLocationItemDto,
  StorageLocationUpdateDto,
  StorageLocationsResponseDto,
} from 'src/dtos/storage-location.dto.js';
import {
  BootstrapEventPriority,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  NetworkShare,
  getNetworkShareMountPath,
  isNetworkSharesSupported,
  parseNfsMounts,
  runCommand,
} from 'src/utils/network-share.js';
import {
  MARKER_FILE,
  RelocatableFolder,
  RelocatableFolders,
  StorageLocation,
  StorageLocationState,
  StorageLocations,
  emptyStorageLocations,
  getDefaultLocationPath,
  getQueuesUsing,
  isIgnoredEntry,
  isWithin,
  locationKey,
  normalizeLocationPath,
  overlaps,
  resolveStorageLocation,
  resolveStorageLocations,
} from 'src/utils/storage-location.js';

const COMMAND_TIMEOUT = 10_000;
/** how often a move reports how far it has got */
const PROGRESS_EVERY = 200;
/** failures in a row after which a move stops, as the NAS has likely gone: the next check starts it again */
const MAX_FAILURES_IN_A_ROW = 20;

type Target = { folder: RelocatableFolder } | { userId: string };
type FileRow = { path: string; update: (to: string) => Promise<void> };

/**
 * Where thumbnails, encoded videos, database backups and each user's originals are kept: in the media location, as
 * Immich keeps them, or in a folder on a network share the server mounts (NetworkShareService), for a Mac whose disk is
 * small beside the library. Every worker resolves the locations to paths StorageCore hands out. The microservices
 * worker checks each minute that they can be used, and pauses the queues that use one while it can't, so that jobs wait
 * for the NAS instead of failing; it moves the files of a folder whose location changed.
 */
@Injectable()
export class StorageLocationService extends BaseService {
  private migrating = false;

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.StorageLocations })
  async onBootstrap() {
    await this.load();
  }

  @OnEvent({ name: 'StorageLocationUpdate', server: true })
  async onUpdate() {
    await this.load();
  }

  /** Resolves the locations, as StorageCore hands them out from now on */
  async load() {
    const locations = await this.getLocations();
    const shares = await this.getShares();
    StorageCore.setStorageLocations(resolveStorageLocations(await this.getMountRoot(), shares, locations));
    return locations;
  }

  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    const locations = await this.getLocations();
    if (!locations.users[id]) {
      return;
    }

    delete locations.users[id];
    await this.saveLocations(locations);
  }

  @OnEvent({ name: 'NetworkSharesChecked', workers: [ImmichWorker.Microservices] })
  async onNetworkSharesChecked({ available }: ArgOf<'NetworkSharesChecked'>) {
    const locations = await this.load();
    const mountRoot = await this.getMountRoot();
    const shares = await this.getShares();
    const unavailable: Record<string, string> = {};

    const entries: [string, StorageLocation][] = [
      ...RelocatableFolders.flatMap((folder) => {
        const location = locations.folders[folder];
        return location ? [[folder, location] as [string, StorageLocation]] : [];
      }),
      ...Object.entries(locations.users).map(
        ([userId, location]) => [`user:${userId}`, location] as [string, StorageLocation],
      ),
    ];
    for (const [key, location] of entries) {
      const share = shares.find((share) => share.id === location.shareId);
      const path = mountRoot && resolveStorageLocation(mountRoot, shares, location);
      if (!share || !path) {
        unavailable[key] = 'The network share it is on was removed';
      } else if (!available[share.id]) {
        unavailable[key] = `The network share ${share.name} is not mounted, or does not answer`;
      } else if (!(await this.hasMarker(path))) {
        // the folder was there, with the marker, when the location was set
        unavailable[key] = `${location.path} is missing on ${share.name}, or the share is another folder than it was`;
      }
    }

    const state = await this.getState();
    const needed = new Set(Object.keys(unavailable).flatMap((key) => getQueuesUsing(key)));
    const paused = new Set(state.pausedQueues);
    for (const queue of needed) {
      // a queue someone paused is theirs to resume
      if (paused.has(queue) || (await this.jobRepository.isPaused(queue))) {
        continue;
      }

      await this.jobRepository.pause(queue);
      paused.add(queue);
    }
    for (const queue of paused) {
      if (needed.has(queue)) {
        continue;
      }

      await this.jobRepository.resume(queue);
      paused.delete(queue);
    }

    const before = JSON.stringify(state.unavailable);
    if (before !== JSON.stringify(unavailable)) {
      for (const [key, message] of Object.entries(unavailable)) {
        if (state.unavailable[key] !== message) {
          this.logger.warn(`Storage location ${key} cannot be used: ${message}. Paused: ${[...paused].join(', ')}`);
        }
      }
      for (const key of Object.keys(state.unavailable)) {
        if (!unavailable[key]) {
          this.logger.log(`Storage location ${key} can be used again`);
        }
      }
    }

    await this.saveState({
      ...state,
      unavailable,
      pausedQueues: [...paused],
      checkedAt: new Date().toISOString(),
    });

    // a move that stopped (the NAS went away, the server restarted) goes on once nothing it needs is away
    const hasPending = Object.values(locations.pending).some((folders) => folders && folders.length > 0);
    if (hasPending && !this.migrating && !paused.has(QueueName.Migration)) {
      await this.jobRepository.queue({ name: JobName.StorageLocationMigration });
    }
  }

  async getAll(): Promise<StorageLocationsResponseDto> {
    this.requireSupport();
    const locations = await this.getLocations();
    const shares = await this.getShares();
    const state = await this.getState();
    const users = await this.userRepository.getList();
    const { storageTemplate } = await this.getConfig({ withCache: false });

    const describe = (key: string, location: StorageLocation | undefined, absolutePath: string) => {
      const share = location && shares.find((share) => share.id === location.shareId);
      const message = state.unavailable[key];
      return {
        location: location && {
          shareId: location.shareId,
          shareName: share?.name ?? '',
          path: location.path,
        },
        absolutePath,
        available: !message,
        message,
      };
    };

    const folders: StorageLocationItemDto[] = RelocatableFolders.map((folder) => ({
      folder,
      ...describe(folder, locations.folders[folder], StorageCore.getBaseFolder(folder)),
      suggestedPath: getDefaultLocationPath({ folder }),
      pendingFrom: locations.pending[folder] ?? [],
      migration: state.migration?.[folder],
    }));

    return {
      folders,
      users: users.map((user) => ({
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        ...describe(locationKey({ userId: user.id }), locations.users[user.id], StorageCore.getLibraryFolder(user)),
        suggestedPath: getDefaultLocationPath({ user }),
        pendingFrom: [],
      })),
      pausedQueues: state.pausedQueues,
      storageTemplateEnabled: storageTemplate.enabled,
      checkedAt: state.checkedAt,
    };
  }

  async setFolder(folder: RelocatableFolder, dto: StorageLocationUpdateDto): Promise<StorageLocationsResponseDto> {
    this.requireSupport();
    const locations = await this.getLocations();
    const current = locations.folders[folder];
    const location = dto.shareId ? await this.validate({ folder }, dto, locations) : undefined;
    if (current?.shareId === location?.shareId && current?.path === location?.path) {
      return this.getAll();
    }

    const from = StorageCore.getBaseFolder(folder);
    const to = location
      ? resolveStorageLocation((await this.getMountRoot())!, await this.getShares(), location)!
      : StorageCore.getDefaultBaseFolder(folder);
    if (location) {
      locations.folders[folder] = location;
    } else {
      delete locations.folders[folder];
      this.storageRepository.mkdirSync(to);
    }
    // where its files are now: moved out of, then forgotten, by the migration
    locations.pending[folder] = [...new Set([...(locations.pending[folder] ?? []), from])].filter(
      (path) => path !== to,
    );

    await this.saveLocations(locations);
    this.logger.log(`Storage location of ${folder}: ${to}, moving the files in ${from}`);
    await this.queueMigration();
    return this.getAll();
  }

  async setUser(userId: string, dto: StorageLocationUpdateDto): Promise<StorageLocationsResponseDto> {
    this.requireSupport();
    const user = await this.userRepository.get(userId, {});
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const { storageTemplate } = await this.getConfig({ withCache: false });
    if (dto.shareId && !storageTemplate.enabled) {
      throw new BadRequestException(
        'Originals are only moved by the storage template: turn it on in Administration > Settings > Storage Template first',
      );
    }

    const locations = await this.getLocations();
    const current = locations.users[userId];
    const location = dto.shareId ? await this.validate({ userId }, dto, locations) : undefined;
    if (current?.shareId === location?.shareId && current?.path === location?.path) {
      return this.getAll();
    }

    if (location) {
      locations.users[userId] = location;
    } else {
      delete locations.users[userId];
    }
    await this.saveLocations(locations);
    this.logger.log(`Storage location of the originals of ${user.email}: ${StorageCore.getLibraryFolder(user)}`);
    // the storage template migration moves every original that isn't where the template puts it
    await this.jobRepository.queue({ name: JobName.StorageTemplateMigration });
    return this.getAll();
  }

  /**
   * Moves the files of the folders whose location changed, from where they were to where they are now: renamed, or
   * copied, checked for size and deleted, across devices; then their paths in the database. A file that can't be moved
   * stays where it is, named by the database, and the next check tries again.
   */
  @OnJob({ name: JobName.StorageLocationMigration, queue: QueueName.Migration })
  async handleMigration(): Promise<JobStatus> {
    if (this.migrating) {
      return JobStatus.Skipped;
    }
    this.migrating = true;
    try {
      for (const folder of RelocatableFolders) {
        const locations = await this.load();
        for (const from of locations.pending[folder] ?? []) {
          const to = StorageCore.getBaseFolder(folder);
          const done =
            from === to ||
            (folder === StorageFolder.Backups
              ? await this.moveBackups(from, to)
              : await this.moveFiles(folder, from, to));
          if (!done) {
            continue;
          }

          const latest = await this.getLocations();
          latest.pending[folder] = (latest.pending[folder] ?? []).filter((path) => path !== from);
          await this.saveLocations(latest);
          await this.removeEmptyDirs(from);
          this.logger.log(`Moved the ${folder} files out of ${from}`);
        }
      }
      return JobStatus.Success;
    } finally {
      this.migrating = false;
    }
  }

  private async moveFiles(folder: RelocatableFolder, from: string, to: string) {
    const prefix = from.endsWith('/') ? from : `${from}/`;
    const total = await this.databaseRepository.countFilesUnder(prefix);
    const progress = { moved: 0, remaining: total, failed: 0 };
    await this.setProgress(folder, progress);

    const rows: AsyncIterable<FileRow>[] = [
      this.mapRows(
        this.databaseRepository.streamAssetFilesUnder(prefix),
        (row) => (to: string) => this.databaseRepository.updateAssetFilePath(row.id, row.path, to),
      ),
      this.mapRows(
        this.databaseRepository.streamPersonFilesUnder(prefix),
        (row) => (to: string) => this.databaseRepository.updatePersonFilePath(row, row.path, to),
      ),
      this.mapRows(
        this.databaseRepository.streamOriginalsUnder(prefix),
        (row) => (to: string) => this.databaseRepository.updateOriginalPath(row.id, row.path, to),
      ),
    ];

    // read first, then moved: an update while the stream is open would wait on it
    const files: FileRow[] = [];
    for (const stream of rows) {
      for await (const row of stream) {
        files.push(row);
      }
    }

    let failures = 0;
    for (const file of files) {
      const target = join(to, relative(from, file.path));
      if (await this.moveFile(file.path, target)) {
        await file.update(target);
        progress.moved++;
        failures = 0;
      } else {
        progress.failed++;
        if (++failures >= MAX_FAILURES_IN_A_ROW) {
          this.logger.warn(`Stopped moving the ${folder} files after ${failures} failures in a row`);
          break;
        }
      }
      progress.remaining--;
      if ((progress.moved + progress.failed) % PROGRESS_EVERY === 0) {
        await this.setProgress(folder, progress);
      }
    }

    await this.setProgress(folder, undefined);
    const left = await this.databaseRepository.countFilesUnder(prefix);
    if (left > 0) {
      this.logger.warn(`${left} ${folder} file(s) are still in ${from}: tried again at the next check`);
    }
    return left === 0;
  }

  /** Database backups: files the database doesn't name, so every file of the folder */
  private async moveBackups(from: string, to: string) {
    let entries: string[];
    try {
      entries = await this.storageRepository.readdir(from);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return true;
      }
      this.logger.warn(`Could not read ${from}: ${error}`);
      return false;
    }

    let done = true;
    for (const entry of entries) {
      if (entry === MARKER_FILE) {
        continue;
      }
      const source = join(from, entry);
      const stat = await this.storageRepository.stat(source).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      done = (await this.moveFile(source, join(to, entry))) && done;
    }
    return done;
  }

  /** Renames it, or across devices copies it, checks the copy's size and deletes it: whether it is at the target */
  private async moveFile(source: string, target: string): Promise<boolean> {
    try {
      this.storageRepository.mkdirSync(dirname(target));
      try {
        await this.storageRepository.rename(source, target);
        return true;
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          // moved before the server stopped, or gone: the database names where it should be
          return true;
        }
        if (error?.code !== 'EXDEV') {
          throw error;
        }
      }

      await this.storageRepository.copyFile(source, target);
      const [before, after] = await Promise.all([
        this.storageRepository.stat(source),
        this.storageRepository.stat(target),
      ]);
      if (before.size !== after.size) {
        await this.storageRepository.unlink(target);
        throw new Error(`the copy is ${after.size} bytes, the file ${before.size}`);
      }
      await this.storageRepository.utimes(target, before.atime, before.mtime);
      await this.storageRepository.unlink(source);
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not move ${source} to ${target}: ${error?.message ?? error}`);
      return false;
    }
  }

  private async *mapRows<T extends { path: string }>(
    rows: AsyncIterable<T>,
    update: (row: T) => (to: string) => Promise<void>,
  ): AsyncIterable<FileRow> {
    for await (const row of rows) {
      yield { path: row.path, update: update(row) };
    }
  }

  private async removeEmptyDirs(folder: string) {
    try {
      await this.storageRepository.removeEmptyDirs(folder);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn(`Could not clean up ${folder}: ${error}`);
      }
    }
  }

  private async setProgress(
    folder: RelocatableFolder,
    progress?: { moved: number; remaining: number; failed: number },
  ) {
    const state = await this.getState();
    const migration = { ...state.migration };
    if (progress) {
      migration[folder] = { ...progress };
    } else {
      delete migration[folder];
    }
    await this.saveState({ ...state, migration });
  }

  private async queueMigration() {
    await this.jobRepository.queue({ name: JobName.StorageLocationMigration });
  }

  /**
   * A location as it is to be stored: on a share that is mounted and writable, in a folder no other location and no
   * external library's import path is in or holds, that is empty or was a location before; created, with its marker
   */
  private async validate(target: Target, dto: StorageLocationUpdateDto, locations: StorageLocations) {
    const shares = await this.getShares();
    const share = shares.find((share) => share.id === dto.shareId);
    if (!share) {
      throw new BadRequestException('Network share not found');
    }
    if (share.readOnly) {
      throw new BadRequestException(`${share.name} is mounted read-only`);
    }
    const path = normalizeLocationPath(dto.path ?? '');
    if (!path) {
      throw new BadRequestException('Give a folder on the share, such as immich/thumbs: not its top level, nor ".."');
    }

    const mountRoot = (await this.getMountRoot())!;
    const mountPath = getNetworkShareMountPath(mountRoot, share);
    const mounted = await this.run('/sbin/mount', ['-t', 'nfs']);
    if (!share.enabled || !parseNfsMounts(mounted.stdout).has(mountPath)) {
      throw new BadRequestException(`${share.name} is not mounted: mount it in Administration > Network shares`);
    }
    const answered = await this.run('/bin/ls', ['-1A', mountPath]);
    if (answered.code !== 0) {
      throw new BadRequestException(`${share.name} does not answer`);
    }

    const absolute = join(mountPath, path);
    const key = locationKey(target);
    const others = resolveStorageLocations(mountRoot, shares, locations);
    const taken = [
      ...Object.entries(others.folders).filter(([folder]) => folder !== key),
      ...Object.entries(others.users)
        .filter(([userId]) => `user:${userId}` !== key)
        .map(([userId, folder]) => [`user:${userId}`, folder] as const),
    ];
    const clash = taken.find(([, folder]) => folder && overlaps(folder, absolute));
    if (clash) {
      throw new BadRequestException(`The folder is, holds, or is in the one ${clash[0]} is kept in`);
    }

    const libraries = await this.libraryRepository.getAll();
    const library = libraries.find((library) =>
      library.importPaths.some((importPath) => isWithin(importPath, absolute)),
    );
    if (library) {
      throw new BadRequestException(`The external library ${library.name} imports from inside this folder`);
    }
    // the other way round is fine for the user's own library, which leaves it out, but not for another user's
    const otherUsers = 'userId' in target ? libraries.filter((library) => library.ownerId !== target.userId) : [];
    const holder = otherUsers.find((library) =>
      library.importPaths.some((importPath) => isWithin(absolute, resolve(importPath))),
    );
    if (holder) {
      throw new BadRequestException(
        `The external library ${holder.name}, another user's, imports from a folder that holds this one`,
      );
    }

    const listed = await this.run('/bin/ls', ['-1A', absolute]);
    const entries = listed.code === 0 ? listed.stdout.split('\n').filter(Boolean) : [];
    if (listed.code === 0 && !entries.includes(MARKER_FILE) && entries.some((entry) => !isIgnoredEntry(entry))) {
      throw new BadRequestException(
        `${path} on ${share.name} is not empty: give an empty or new folder, so that Immich's files are kept apart from yours`,
      );
    }

    const made = await this.run('/bin/mkdir', ['-p', absolute]);
    const marked = made.code === 0 && (await this.run('/usr/bin/touch', [join(absolute, MARKER_FILE)]));
    if (!marked || marked.code !== 0) {
      throw new BadRequestException(
        `Could not create ${path} on ${share.name}: ${(marked || made).stderr.trim() || 'no answer'}`,
      );
    }

    return { shareId: share.id, path };
  }

  private async hasMarker(folder: string) {
    const result = await this.run('/bin/test', ['-f', join(folder, MARKER_FILE)]);
    return result.code === 0;
  }

  private requireSupport() {
    if (!isNetworkSharesSupported(this.configRepository.getEnv().storage.networkSharesLocation)) {
      throw new BadRequestException('Storage locations are only available when Immich runs natively on macOS');
    }
  }

  /** Where the shares are mounted, as `mount` lists it (NetworkShareService.getMountPath) */
  private async getMountRoot() {
    const location = this.configRepository.getEnv().storage.networkSharesLocation;
    if (!isNetworkSharesSupported(location)) {
      return;
    }
    this.storageRepository.mkdirSync(location);
    return this.storageRepository.realpath(location);
  }

  private async getShares(): Promise<NetworkShare[]> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.NetworkShares);
    return value?.shares ?? [];
  }

  private async getLocations(): Promise<StorageLocations> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.StorageLocations);
    return { ...emptyStorageLocations(), ...value };
  }

  /** Saves them, and has every worker read them again */
  private async saveLocations(locations: StorageLocations) {
    await this.systemMetadataRepository.set(SystemMetadataKey.StorageLocations, locations);
    await this.load();
    this.websocketRepository.serverSend('StorageLocationUpdate');
  }

  private async getState(): Promise<StorageLocationState> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.StorageLocationState);
    return { unavailable: {}, pausedQueues: [], ...value };
  }

  private async saveState(state: StorageLocationState) {
    await this.systemMetadataRepository.set(SystemMetadataKey.StorageLocationState, state);
  }

  private run(command: string, args: string[]) {
    return runCommand((cmd, cmdArgs) => this.processRepository.spawn(cmd, cmdArgs), command, args, COMMAND_TIMEOUT);
  }
}
