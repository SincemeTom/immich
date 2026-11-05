import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { SynologyConnection } from 'src/repositories/synology.repository.js';
import type { JobOf, SynologyAccount, SynologySyncReport } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  SynologyAccountBindDto,
  SynologyAccountResponseDto,
  SynologyAccountTestResponseDto,
  SynologySyncScheduleDto,
  SynologyUnmatchedDto,
} from 'src/dtos/synology.dto.js';
import { AlbumUserRole, CronJob, ImmichWorker, JobName, JobStatus, QueueName, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { toAlbumUserAccess } from 'src/utils/album-access.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { isNetworkSharesSupported } from 'src/utils/network-share.js';
import { getPreferences } from 'src/utils/preferences.js';
import {
  SYNOLOGY_SYNC_TIME,
  SynologyError,
  SynologyErrorReason,
  SynologyNameIndex,
  SynologyPathIndex,
  SynologyUnmatchedReason,
  getAuthErrorReason,
  getNextScheduled,
  isSynologySyncDue,
  toSynologyAlbumAccess,
  toSynologyPath,
  toSynologyUrl,
} from 'src/utils/synology.js';

/** The Keychain items: this service, and the Immich user's ID as the account */
export const SYNOLOGY_KEYCHAIN_SERVICE = 'Immich Synology';
/** The name of the session on Synology, and of this server in the account's trusted devices */
const SESSION = 'Immich';
const PAGE = 500;
/** a sync asked for longer ago than this, and not run, was lost (a queue emptied) */
const PENDING_FOR = 6 * 60 * 60 * 1000;

/** What is kept in the Keychain: the password, and the token that spares 2-step verification codes */
type Secret = { password: string; deviceId?: string };

type Session = {
  success: true;
  sid: string;
  version: number;
  secret: Secret;
  me: { id: number; uid?: number; name?: string };
};
type Connected = {
  success: true;
  secret: Secret;
  photosUserId: number;
  dsmUserId?: number;
  name?: string;
  albumCount: number;
};
type Failed = { success: false; reason: SynologyErrorReason; message: string };

type SynologyPermission = { db_id?: number; name?: string; role?: string; type?: string };
type SynologyAlbum = {
  id: number;
  name: string;
  item_count?: number;
  owner_user_id?: number;
  passphrase?: string;
  shared?: boolean;
  additional?: {
    thumbnail?: { unit_id?: number };
    sharing_info?: { permission?: SynologyPermission[] };
  };
};
type SynologyItem = {
  id: number;
  filename: string;
  filesize?: number;
  folder_id?: number;
  owner_user_id?: number;
  /** the local time it was taken, encoded as UTC, in seconds */
  time?: number;
};

/** Another Synology Photos user: one the account's albums are shared with, or who added photos to them */
type SynologyMember = {
  /** their Immich user: who logged in with Synology SSO as them, or bound their account */
  userId?: string;
  name?: string;
  /** whether they bound their account: their photos' folders are read with it */
  bound: boolean;
  folders: Map<number, string | null>;
  /** their folders could not be read: their photos the sync added are not removed then */
  unsure: boolean;
  paths?: SynologyPathIndex;
  names?: SynologyNameIndex;
};

/** A user's photos to look for Synology's in, indexed once a sync needs them */
type Lookup = { userId: string; paths?: SynologyPathIndex; names?: SynologyNameIndex };

/** An album, or a photo of it, that a sync could not match */
type Unmatched = {
  synologyAlbumId: number;
  albumName: string;
  reason: SynologyUnmatchedReason;
  path: string | null;
  mine: boolean;
};

/** What one sync works with: the account, logged in, and what it read so far */
type SyncContext = {
  userId: string;
  connection: SynologyConnection;
  photosUserId: number;
  sid: string;
  source: string;
  accounts: Record<string, SynologyAccount>;
  report: SynologySyncReport;
  folders: Map<number, string | null>;
  /** the user's own photos */
  self: Lookup;
  members: Map<number, SynologyMember>;
  /** the Synology Photos users not found in Immich */
  waiting: Set<number>;
  added: Set<string>;
  removed: Set<string>;
  coverRemoved: boolean;
  unmatched: Unmatched[];
};

/** An album of the account, and its photos: none when they could not be read */
type ReadAlbum = { album: SynologyAlbum; items?: SynologyItem[] };

/** The photos of an album found in Immich */
type Matched = {
  assetIds: string[];
  byItem: Map<number, string>;
  /** whether every photo of the account could be looked for: the photos the sync added are not removed otherwise */
  complete: boolean;
  /** the users whose photos could not all be looked for: theirs are not removed */
  unsure: Set<string>;
};

const toUnmatched = (
  album: SynologyAlbum,
  reason: SynologyUnmatchedReason,
  path: string | null = null,
  mine = true,
): Unmatched => ({ synologyAlbumId: album.id, albumName: album.name, reason, path, mine });

/**
 * Each user binds their own Synology account, which the album sync reads Synology Photos with. Binding logs in
 * first: an account is only kept when the login works. The password goes into the macOS Keychain; the database keeps
 * the address, the account name and what the last login found.
 *
 * The sync goes one way, Synology to Immich, and changes nothing on Synology: each album of the account becomes an
 * album of the user, with the account's own photos found by their paths in the user's own external libraries, where
 * the Synology Photos folders are mounted. It only changes the albums it created, and only removes the photos it added.
 */
@Injectable()
export class SynologyService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    if (!this.isSupported()) {
      return;
    }

    this.cronRepository.create({
      name: CronJob.SynologyAlbumSync,
      expression: '* * * * *',
      onTick: () => handlePromiseError(this.queueDueSyncs(), this.logger),
      start: true,
    });
  }

  async getAccount(auth: AuthDto): Promise<SynologyAccountResponseDto> {
    this.requireSupport();
    const accounts = await this.getAccounts();
    return this.map(accounts[auth.user.id]);
  }

  async bindAccount(auth: AuthDto, dto: SynologyAccountBindDto): Promise<SynologyAccountTestResponseDto> {
    this.requireSupport();
    const url = toSynologyUrl(dto.url);
    if (!url) {
      throw new BadRequestException('Must be an address such as https://nas.example.com:5001');
    }

    const current = await this.getUserAccount(auth.user.id);
    const same = !!current && current.url === url && current.account.toLowerCase() === dto.account.toLowerCase();
    const stored = same ? await this.readSecret(auth.user.id).catch(() => null) : null;
    if (!dto.password && !stored) {
      throw new BadRequestException('Enter the password of the NAS account');
    }

    const secret: Secret = { password: dto.password ?? stored!.password, deviceId: stored?.deviceId };
    const connection = { url, verifyCertificate: dto.verifyCertificate };
    const result = await this.connect(connection, dto.account, secret, dto.otpCode);
    if (!result.success) {
      return this.failed(result, current);
    }

    // read again, as logging in took a while
    const accounts = await this.getAccounts();
    const taken = Object.entries(accounts).some(
      ([id, other]) => id !== auth.user.id && other.url === url && other.photosUserId === result.photosUserId,
    );
    if (taken) {
      return this.failed(
        {
          success: false,
          reason: SynologyErrorReason.AlreadyBound,
          message: 'Another Immich user bound this NAS account',
        },
        current,
      );
    }

    try {
      await this.keychainRepository.set(
        SYNOLOGY_KEYCHAIN_SERVICE,
        auth.user.id,
        JSON.stringify(result.secret),
        `Immich: Synology account of ${auth.user.email}`,
      );
    } catch (error) {
      return this.failed({ success: false, reason: SynologyErrorReason.Keychain, message: String(error) }, current);
    }

    const now = new Date().toISOString();
    const previous = accounts[auth.user.id];
    // the same Synology Photos account, under its name or another: what its syncs did still stands
    const sameAccount = !!previous && previous.url === url && previous.photosUserId === result.photosUserId;
    const account: SynologyAccount = {
      url,
      verifyCertificate: dto.verifyCertificate,
      account: dto.account,
      photosUserId: result.photosUserId,
      dsmUserId: result.dsmUserId,
      name: result.name,
      boundAt: (same && current?.boundAt) || now,
      checkedAt: now,
      albumCount: result.albumCount,
      autoSync: previous?.autoSync,
      syncTime: previous?.syncTime,
      scheduledAt: previous?.scheduledAt,
      ...(sameAccount && { syncQueuedAt: previous.syncQueuedAt, lastSync: previous.lastSync }),
    };
    await this.saveAccounts({ ...accounts, [auth.user.id]: account });
    this.logger.log(`User ${auth.user.id} bound Synology account ${dto.account} at ${url}`);

    return { success: true, albumCount: result.albumCount, account: this.map(account) };
  }

  async testAccount(auth: AuthDto): Promise<SynologyAccountTestResponseDto> {
    this.requireSupport();
    const current = await this.getUserAccount(auth.user.id);
    if (!current) {
      throw new NotFoundException('No NAS account is bound');
    }

    let result: Connected | Failed | undefined;
    let secret: Secret | null = null;
    try {
      secret = await this.readSecret(auth.user.id);
    } catch (error) {
      result = { success: false, reason: SynologyErrorReason.Keychain, message: String(error) };
    }
    if (!result) {
      result = secret
        ? await this.connect(current, current.account, secret)
        : {
            success: false,
            reason: SynologyErrorReason.Keychain,
            message: 'The password is not in the Keychain: bind the account again',
          };
    }

    if (result.success) {
      await this.keepSecret(auth.user.id, secret, result.secret);
    }

    // read again, as logging in took a while; and the account may have been unbound meanwhile
    const accounts = await this.getAccounts();
    const account = accounts[auth.user.id];
    if (!account) {
      throw new NotFoundException('No NAS account is bound');
    }

    account.checkedAt = new Date().toISOString();
    if (result.success) {
      account.albumCount = result.albumCount;
      account.name = result.name;
      delete account.error;
    } else {
      account.error = { reason: result.reason, message: result.message };
    }
    await this.saveAccounts(accounts);

    return result.success
      ? { success: true, albumCount: result.albumCount, account: this.map(account) }
      : { success: false, errorReason: result.reason, message: result.message, account: this.map(account) };
  }

  async unbindAccount(auth: AuthDto): Promise<void> {
    this.requireSupport();
    await this.removeAccount(auth.user.id);
  }

  /** What the last sync could not match: albums, and photos */
  async getUnmatched(auth: AuthDto): Promise<SynologyUnmatchedDto[]> {
    this.requireSupport();
    const account = await this.getUserAccount(auth.user.id);
    // the list goes with the account's last report
    if (!account?.lastSync?.success) {
      return [];
    }

    const rows = await this.synologyAlbumRepository.getUnmatched(auth.user.id);
    return rows.map(({ synologyAlbumId, albumName, reason, path, mine }) => ({
      albumId: synologyAlbumId,
      albumName,
      reason: reason as SynologyUnmatchedReason,
      path: path ?? undefined,
      mine,
    }));
  }

  /** Syncs the albums now, in the background */
  async syncAccount(auth: AuthDto): Promise<SynologyAccountResponseDto> {
    this.requireSupport();
    const accounts = await this.getAccounts();
    const account = accounts[auth.user.id];
    if (!account) {
      throw new NotFoundException('No NAS account is bound');
    }

    account.syncQueuedAt = new Date().toISOString();
    await this.saveAccounts(accounts);
    await this.jobRepository.queue({ name: JobName.SynologyAlbumSync, data: { id: auth.user.id } });
    return this.map(account);
  }

  async updateSchedule(auth: AuthDto, dto: SynologySyncScheduleDto): Promise<SynologyAccountResponseDto> {
    this.requireSupport();
    const accounts = await this.getAccounts();
    const account = accounts[auth.user.id];
    if (!account) {
      throw new NotFoundException('No NAS account is bound');
    }

    account.autoSync = dto.autoSync;
    account.syncTime = dto.syncTime;
    account.scheduledAt = new Date().toISOString();
    await this.saveAccounts(accounts);
    return this.map(account);
  }

  /** Every minute: queues the syncs of the accounts whose time came round */
  async queueDueSyncs(now = new Date()) {
    const accounts = await this.getAccounts();
    const due = Object.entries(accounts)
      .filter(([, account]) => isSynologySyncDue(account, now))
      .map(([id]) => id);
    if (due.length === 0) {
      return;
    }

    for (const id of due) {
      accounts[id].syncQueuedAt = now.toISOString();
    }
    await this.saveAccounts(accounts);
    await this.jobRepository.queueAll(due.map((id) => ({ name: JobName.SynologyAlbumSync, data: { id } })));
  }

  @OnJob({ name: JobName.SynologyAlbumSync, queue: QueueName.BackgroundTask })
  async handleAlbumSync({ id }: JobOf<JobName.SynologyAlbumSync>): Promise<JobStatus> {
    if (!this.isSupported()) {
      return JobStatus.Skipped;
    }

    const account = await this.getUserAccount(id);
    if (!account) {
      return JobStatus.Skipped;
    }

    const report: SynologySyncReport = {
      startedAt: new Date().toISOString(),
      finishedAt: '',
      success: true,
      albums: 0,
      albumsCreated: 0,
      albumsUpdated: 0,
      albumsRemoved: 0,
      albumsEmpty: 0,
      albumsFailed: 0,
      items: 0,
      matched: 0,
      matchedByName: 0,
      others: 0,
      othersMatched: 0,
      othersWaiting: 0,
      ambiguous: 0,
      membersAdded: 0,
      membersUpdated: 0,
      membersRemoved: 0,
      added: 0,
      removed: 0,
      membersWaiting: 0,
      unmatched: 0,
    };
    const unmatched: Unmatched[] = [];

    let failure: Failed | undefined;
    let secret: Secret | null = null;
    try {
      secret = await this.readSecret(id);
    } catch (error) {
      failure = { success: false, reason: SynologyErrorReason.Keychain, message: String(error) };
    }

    if (!failure && !secret) {
      failure = {
        success: false,
        reason: SynologyErrorReason.Keychain,
        message: 'The password is not in the Keychain: bind the account again',
      };
    }

    if (!failure && secret) {
      const result = await this.withSession(account, account.account, secret, (session) =>
        this.syncAlbums(id, account, session, report, unmatched),
      );
      if (result.success) {
        await this.keepSecret(id, secret, result.secret);
      } else {
        failure = result;
      }
    }

    if (failure) {
      report.success = false;
      report.errorReason = failure.reason;
      report.message = failure.message;
    }
    report.unmatched = failure ? 0 : unmatched.length;
    report.finishedAt = new Date().toISOString();

    // read again, as the sync took a while; the account may have been unbound, or another bound meanwhile
    const accounts = await this.getAccounts();
    const current = accounts[id];
    if (current && current.url === account.url && current.photosUserId === account.photosUserId) {
      current.lastSync = report;
      await this.saveAccounts(accounts);
      // the list goes with the report: none when the sync failed
      await this.synologyAlbumRepository.setUnmatched(id, failure ? [] : unmatched);
    }

    if (failure) {
      this.logger.warn(`Could not sync the Synology albums of user ${id}: ${failure.message}`);
      return JobStatus.Failed;
    }

    this.logger.log(
      `Synced the Synology albums of user ${id}: ${report.albums} albums (${report.albumsCreated} created, ` +
        `${report.albumsUpdated} changed, ${report.albumsRemoved} removed), ${report.matched} of ${report.items} ` +
        `photos found (${report.matchedByName} by name), ${report.othersMatched} of ${report.others} added by others, ` +
        `${report.added} added, ${report.unmatched} not matched, ` +
        `${report.removed} removed; ${report.membersAdded} members added, ${report.membersUpdated} changed, ` +
        `${report.membersRemoved} removed`,
    );
    return JobStatus.Success;
  }

  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    if (!this.isSupported()) {
      return;
    }

    await this.removeAccount(id).catch((error) =>
      this.logger.warn(`Could not remove the Synology account of user ${id}: ${error}`),
    );
  }

  private async syncAlbums(
    userId: string,
    account: SynologyAccount,
    session: Session,
    report: SynologySyncReport,
    unmatched: Unmatched[],
  ) {
    const ctx: SyncContext = {
      userId,
      connection: account,
      photosUserId: account.photosUserId,
      sid: session.sid,
      // the albums synced from another account, bound before, are left as they are
      source: `${account.url}#${account.photosUserId}`,
      accounts: await this.getAccounts(),
      report,
      folders: new Map(),
      self: { userId },
      members: new Map(),
      waiting: new Set(),
      added: new Set(),
      removed: new Set(),
      coverRemoved: false,
      unmatched,
    };

    const listed = await this.list<SynologyAlbum>(ctx.connection, ctx.sid, 'SYNO.Foto.Browse.Album', 'list', 2, {
      additional: ['sharing_info', 'thumbnail'],
    });
    const albums = listed.filter(
      ({ owner_user_id }) => owner_user_id === undefined || owner_user_id === ctx.photosUserId,
    );
    report.albums = albums.length;

    const read: ReadAlbum[] = [];
    for (const album of albums) {
      try {
        read.push({ album, items: await this.listItems(ctx, album) });
      } catch (error) {
        report.albumsFailed++;
        unmatched.push(toUnmatched(album, SynologyUnmatchedReason.AlbumFailed));
        this.logger.warn(`Could not read Synology album ${album.id} of user ${userId}: ${error}`);
        read.push({ album });
      }
    }

    await this.findMembers(ctx, read);
    await this.readMemberFolders(ctx, read);

    const rows = await this.synologyAlbumRepository.getAll(userId);
    const synced = new Map(rows.filter(({ source }) => source === ctx.source).map((row) => [row.synologyAlbumId, row]));

    const userMetadata = await this.userRepository.getMetadata(userId);
    const order = getPreferences(userMetadata).albums.defaultAssetOrder;

    for (const { album, items } of read) {
      const row = synced.get(album.id);
      synced.delete(album.id);
      if (!items) {
        continue;
      }

      const present = row ? await this.synologyAlbumRepository.getAlbumAssetIds(row.albumId) : new Set<string>();
      const matched = await this.matchItems(ctx, album, items, present);
      const coverItemId = album.additional?.thumbnail?.unit_id;
      const coverAssetId = coverItemId === undefined ? undefined : matched.byItem.get(coverItemId);

      if (row) {
        await this.updateAlbum(ctx, row, album, matched, present, coverItemId, coverAssetId);
        continue;
      }

      const { assetIds } = matched;
      if (assetIds.length === 0) {
        report.albumsEmpty++;
        unmatched.push(toUnmatched(album, SynologyUnmatchedReason.AlbumEmpty));
        continue;
      }

      const created = await this.albumRepository.create(
        { albumName: album.name, albumThumbnailAssetId: coverAssetId ?? assetIds[0], order },
        [],
        [{ userId, ...toAlbumUserAccess(AlbumUserRole.Owner, {}) }],
        userId,
      );
      await this.synologyAlbumRepository.create({
        albumId: created.id,
        userId,
        source: ctx.source,
        synologyAlbumId: album.id,
        name: album.name,
        thumbnailItemId: coverAssetId ? coverItemId : null,
      });
      await this.albumRepository.addAssetIds(created.id, assetIds);
      await this.synologyAlbumRepository.addAssetIds(created.id, assetIds);
      for (const assetId of assetIds) {
        ctx.added.add(assetId);
      }
      report.albumsCreated++;
      report.added += assetIds.length;

      const members = await this.syncMembers(ctx, created.id, album, [
        { user: { id: userId }, role: AlbumUserRole.Owner },
      ]);
      await this.eventRepository.emit('AlbumUpdate', { id: created.id, userIds: members.userIds, recipientIds: [] });
    }

    // a Synology that lists no album at all, of an account that had some, is taken for one that failed to
    if (albums.length === 0 && synced.size > 0) {
      this.logger.warn(`Synology listed no album of user ${userId}: the albums synced before are kept`);
    } else {
      for (const row of synced.values()) {
        const assetIds = await this.synologyAlbumRepository.getAlbumAssetIds(row.albumId);
        await this.albumRepository.delete(row.albumId);
        for (const assetId of assetIds) {
          ctx.removed.add(assetId);
        }
        report.albumsRemoved++;
      }
    }

    if (ctx.coverRemoved) {
      await this.albumRepository.updateThumbnails();
    }

    report.membersWaiting = ctx.waiting.size;
    await this.inferLocations(ctx);
  }

  /** Brings an album the sync created before up to date: its name, its cover, its photos, its members */
  private async updateAlbum(
    ctx: SyncContext,
    row: { albumId: string; name: string; thumbnailItemId: number | null },
    album: SynologyAlbum,
    { assetIds, complete, unsure }: Matched,
    present: Set<string>,
    coverItemId: number | undefined,
    coverAssetId: string | undefined,
  ) {
    const { albumId } = row;
    const current = await this.albumRepository.getById(albumId, { withAssets: false });
    if (!current) {
      return;
    }

    const tracked = await this.synologyAlbumRepository.getAssetIds(albumId);
    const wanted = new Set(assetIds);
    // the photos missing, even those the user took out: Synology's album is the one to change
    const toAdd = assetIds.filter((id) => !present.has(id));
    // only the photos the sync added, and only when it could look for them all: those the user added stay
    let toRemove = complete ? [...tracked.difference(wanted)] : [];
    if (toRemove.length > 0 && unsure.size > 0) {
      const owners = await this.synologyAlbumRepository.getAssetOwners(toRemove);
      toRemove = toRemove.filter((id) => !unsure.has(owners.get(id) ?? ''));
    }

    await this.albumRepository.addAssetIds(albumId, toAdd);
    await this.synologyAlbumRepository.addAssetIds(albumId, toAdd);
    await this.albumRepository.removeAssetIds(albumId, toRemove);
    await this.synologyAlbumRepository.removeAssetIds(albumId, toRemove);

    const values: { albumName?: string; albumThumbnailAssetId?: string; updatedAt?: Date } = {};
    if (album.name !== row.name) {
      values.albumName = album.name;
    }

    let thumbnailItemId = row.thumbnailItemId;
    if (coverItemId !== undefined && coverAssetId && coverItemId !== row.thumbnailItemId) {
      values.albumThumbnailAssetId = coverAssetId;
      thumbnailItemId = coverItemId;
    } else if (!current.albumThumbnailAssetId && toAdd.length > 0) {
      values.albumThumbnailAssetId = toAdd[0];
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      values.updatedAt = new Date();
    }

    const removedCover =
      !values.albumThumbnailAssetId &&
      !!current.albumThumbnailAssetId &&
      toRemove.includes(current.albumThumbnailAssetId);
    ctx.coverRemoved ||= removedCover;

    if (Object.keys(values).length > 0) {
      await this.albumRepository.update(albumId, { id: albumId, ...values }, ctx.userId);
    }

    await this.synologyAlbumRepository.update(albumId, { name: album.name, thumbnailItemId, syncedAt: new Date() });

    for (const assetId of toAdd) {
      ctx.added.add(assetId);
    }
    for (const assetId of toRemove) {
      ctx.removed.add(assetId);
    }
    ctx.report.added += toAdd.length;
    ctx.report.removed += toRemove.length;

    const members = await this.syncMembers(ctx, albumId, album, current.albumUsers);
    if (Object.keys(values).length > 0 || members.changed) {
      ctx.report.albumsUpdated++;
    }

    if (toAdd.length > 0 || toRemove.length > 0 || members.changed) {
      await this.eventRepository.emit('AlbumUpdate', { id: albumId, userIds: members.userIds, recipientIds: [] });
    }
  }

  /**
   * Shares an album as Synology shares it, with the members found in Immich: view only, download, or add photos. It
   * only changes and removes the members it added; a member the owner added by hand, or took out, stays as they are
   */
  private async syncMembers(
    ctx: SyncContext,
    albumId: string,
    album: SynologyAlbum,
    albumUsers: Array<{ user: { id: string }; role: AlbumUserRole }>,
  ) {
    const present = new Map(albumUsers.map(({ user, role }) => [user.id, role]));
    const sharing = album.additional?.sharing_info;
    // a shared album whose sharing Synology did not give: its members are left as they are
    if (!sharing && album.shared) {
      return { changed: false, userIds: present.keys().toArray() };
    }

    const wanted = new Map<string, string>();
    for (const { db_id, role, type } of sharing?.permission ?? []) {
      if (type !== 'user' || typeof db_id !== 'number' || !role || !toSynologyAlbumAccess(role)) {
        continue;
      }

      const member = ctx.members.get(db_id);
      if (member?.userId) {
        wanted.set(member.userId, role);
      } else {
        ctx.waiting.add(db_id);
      }
    }

    const { report } = ctx;
    const tracked = await this.synologyAlbumRepository.getMembers(albumId);
    let changed = false;

    for (const [memberId, role] of wanted) {
      const last = tracked.get(memberId);
      const current = present.get(memberId);
      const access = toSynologyAlbumAccess(role)!;

      if (last === undefined) {
        if (current !== undefined) {
          // shared with them by hand
          continue;
        }

        await this.albumUserRepository.create({ albumId, userId: memberId, ...access });
        await this.synologyAlbumRepository.setMember(albumId, memberId, role);
        present.set(memberId, access.role);
        report.membersAdded++;
        changed = true;
        continue;
      }

      // taken out in Immich: not shared again; nor changed when Synology's role did not change
      if (current === undefined || current === AlbumUserRole.Owner || last === role) {
        continue;
      }

      await this.albumUserRepository.update({ albumId, userId: memberId }, access);
      await this.synologyAlbumRepository.setMember(albumId, memberId, role);
      present.set(memberId, access.role);
      report.membersUpdated++;
      changed = true;
    }

    for (const memberId of tracked.keys()) {
      if (wanted.has(memberId)) {
        continue;
      }

      await this.synologyAlbumRepository.removeMember(albumId, memberId);
      const current = present.get(memberId);
      if (current === undefined || current === AlbumUserRole.Owner) {
        continue;
      }

      await this.albumUserRepository.delete({ albumId, userId: memberId });
      present.delete(memberId);
      report.membersRemoved++;
      changed = true;
    }

    return { changed, userIds: present.keys().toArray() };
  }

  /**
   * The Immich users of the Synology Photos users the albums are shared with, or who added photos to them: who bound
   * their Synology account here, or else who logged in with Synology SSO as them. Never by name or email
   */
  private async findMembers(ctx: SyncContext, read: ReadAlbum[]) {
    const names = new Map<number, string>();
    const ids = new Set<number>();
    for (const { album, items } of read) {
      for (const { db_id, name, type } of album.additional?.sharing_info?.permission ?? []) {
        if (!(type === 'user' && typeof db_id === 'number')) {
          continue;
        }

        ids.add(db_id);
        if (name) {
          names.set(db_id, name);
        }
      }
      for (const { owner_user_id } of items ?? []) {
        if (owner_user_id !== undefined) {
          ids.add(owner_user_id);
        }
      }
    }
    ids.delete(ctx.photosUserId);

    const bound = new Map<number, string>();
    for (const [id, other] of Object.entries(ctx.accounts)) {
      if (id !== ctx.userId && other.url === ctx.connection.url) {
        bound.set(other.photosUserId, id);
      }
    }

    const users = await this.synologyAlbumRepository.getUsersByOAuthIds([...new Set(names.values())]);
    const byLogin = new Map(users.map(({ id, oauthId }) => [oauthId.toLowerCase(), id]));

    for (const id of ids) {
      const name = names.get(id);
      const userId = bound.get(id) ?? (name ? byLogin.get(name.toLowerCase()) : undefined);
      ctx.members.set(id, {
        userId: userId === ctx.userId ? undefined : userId,
        name,
        bound: bound.has(id),
        folders: new Map(),
        unsure: false,
      });
    }
  }

  /**
   * The folders of the photos others added, read with their own Synology account when they bound it: the account
   * the album belongs to cannot read them
   */
  private async readMemberFolders(ctx: SyncContext, read: ReadAlbum[]) {
    const folders = new Map<number, Set<number>>();
    for (const { items } of read) {
      for (const { owner_user_id, folder_id } of items ?? []) {
        const member = owner_user_id === undefined ? undefined : ctx.members.get(owner_user_id);
        if (!member?.userId || !member.bound || folder_id === undefined) {
          continue;
        }

        const ids = folders.get(owner_user_id!);
        if (ids) {
          ids.add(folder_id);
        } else {
          folders.set(owner_user_id!, new Set([folder_id]));
        }
      }
    }

    for (const [photosUserId, ids] of folders) {
      const member = ctx.members.get(photosUserId)!;
      const memberId = member.userId!;
      const account = ctx.accounts[memberId];
      const secret = await this.readSecret(memberId).catch(() => null);
      if (!secret) {
        member.unsure = true;
        continue;
      }

      const result = await this.withSession(account, account.account, secret, async (session) => {
        if (session.me.id !== photosUserId) {
          throw new Error('The bound account is another user of the NAS photo app now');
        }
        for (const id of ids) {
          member.folders.set(id, await this.readFolder(account, session.sid, id));
        }
      });

      if (result.success) {
        await this.keepSecret(memberId, secret, result.secret);
      } else {
        member.unsure = true;
        this.logger.warn(`Could not read the Synology folders of user ${memberId}: ${result.message}`);
      }
    }
  }

  /** The photos of an album, by album ID, or by its sharing link for an album the account cannot list by ID */
  private async listItems(ctx: SyncContext, album: SynologyAlbum) {
    const items = await this.list<SynologyItem>(ctx.connection, ctx.sid, 'SYNO.Foto.Browse.Item', 'list', 1, {
      album_id: album.id,
    });
    if (items.length === 0 && album.passphrase && album.item_count) {
      return this.list<SynologyItem>(ctx.connection, ctx.sid, 'SYNO.Foto.Browse.Item', 'list', 1, {
        passphrase: album.passphrase,
      });
    }
    return items;
  }

  /**
   * The photos of an album found in Immich: the account's own in the user's photos; those others added in their own
   * photos, once they are in Immich. Those not found, found more than once, or whose owners are not in Immich yet are
   * listed
   */
  private async matchItems(
    ctx: SyncContext,
    album: SynologyAlbum,
    items: SynologyItem[],
    present: Set<string>,
  ): Promise<Matched> {
    const { report } = ctx;
    const matched: Matched = { assetIds: [], byItem: new Map(), complete: true, unsure: new Set() };
    const seen = new Set<string>();
    const add = (itemId: number, assetId: string) => {
      matched.byItem.set(itemId, assetId);
      if (seen.has(assetId)) {
        return;
      }

      seen.add(assetId);
      matched.assetIds.push(assetId);
    };
    const list = (reason: SynologyUnmatchedReason, path: string, mine: boolean) => {
      ctx.unmatched.push(toUnmatched(album, reason, path, mine));
    };

    for (const item of items) {
      const mine = item.owner_user_id === undefined || item.owner_user_id === ctx.photosUserId;
      let lookup: Lookup;
      let folder: string | null;

      if (mine) {
        report.items++;
        folder = item.folder_id === undefined ? null : await this.getFolder(ctx, item.folder_id);
        if (folder === null && item.folder_id !== undefined) {
          matched.complete = false;
        }
        lookup = ctx.self;
      } else {
        report.others++;
        const member = ctx.members.get(item.owner_user_id!);
        if (!member?.userId) {
          report.othersWaiting++;
          ctx.waiting.add(item.owner_user_id!);
          list(SynologyUnmatchedReason.OwnerWaiting, item.filename, false);
          continue;
        }

        if (member.unsure) {
          matched.unsure.add(member.userId);
        }
        folder = (item.folder_id === undefined ? undefined : member.folders.get(item.folder_id)) ?? null;
        lookup = member as Lookup;
      }

      const path = folder === null ? item.filename : toSynologyPath(folder, item.filename);
      const found = await this.findAsset(lookup, folder === null ? undefined : path, item, present);
      if (!found.assetId) {
        list(SynologyUnmatchedReason.NotFound, path, mine);
        continue;
      }

      if (found.count > 1) {
        report.ambiguous++;
        list(SynologyUnmatchedReason.Ambiguous, path, mine);
      }
      if (mine) {
        report.matched++;
        report.matchedByName += Number(found.byName);
      } else {
        report.othersMatched++;
      }
      add(item.id, found.assetId);
    }

    return matched;
  }

  /**
   * A photo in its owner's own photos: by its path in their external libraries, when its folder could be read; else
   * by its name, size and time in all their photos, uploads too, when Synology gave its size and time
   */
  private async findAsset(lookup: Lookup, path: string | undefined, item: SynologyItem, present: Set<string>) {
    if (path !== undefined) {
      lookup.paths ??= await this.loadPathIndex(lookup.userId);
      const asset = lookup.paths.find(path, item.filesize);
      if (asset) {
        return { assetId: asset.id, byName: false, count: 1 };
      }
    }

    if (!item.filesize || item.time === undefined) {
      return { byName: false, count: 0 };
    }

    if (!lookup.names) {
      const names = new SynologyNameIndex();
      for await (const asset of this.synologyAlbumRepository.getUserAssets(lookup.userId)) {
        names.add(asset);
      }
      lookup.names = names;
    }
    const { asset, count } = lookup.names.find(item, present);
    return { assetId: asset?.id, byName: true, count };
  }

  /** The path of a folder of the account's personal space, relative to its Photos folder; null when not readable */
  private async getFolder(ctx: SyncContext, id: number) {
    if (ctx.folders.has(id)) {
      return ctx.folders.get(id)!;
    }

    const folder = await this.readFolder(ctx.connection, ctx.sid, id);
    ctx.folders.set(id, folder);
    return folder;
  }

  private async readFolder(connection: SynologyConnection, sid: string, id: number) {
    const response = await this.synologyRepository.call<{ folder?: { name?: string }; name?: string }>(
      connection,
      'SYNO.Foto.Browse.Folder',
      'get',
      1,
      { id },
      sid,
    );
    const name = response.success ? (response.data?.folder?.name ?? response.data?.name) : undefined;
    return typeof name === 'string' ? name : null;
  }

  private async loadPathIndex(userId: string) {
    const index = new SynologyPathIndex();
    for await (const asset of this.synologyAlbumRepository.getLibraryAssets(userId)) {
      index.add(asset);
    }
    this.logger.debug(`${index.size} photos of the external libraries of user ${userId} to find Synology's in`);
    return index;
  }

  /** Photos added to albums, or taken out, may give a location to the album users' photos taken around them */
  private async inferLocations(ctx: SyncContext) {
    if (ctx.added.size === 0 && ctx.removed.size === 0) {
      return;
    }

    const { metadata } = await this.getConfig({ withCache: true });
    if (!metadata.locationInference.enabled) {
      return;
    }

    const removed = [...ctx.removed];
    const inferredFrom = removed.length > 0 ? await this.assetJobRepository.getInferredFrom(removed) : [];
    const ids = new Set([...ctx.added, ...removed, ...inferredFrom.map(({ id }) => id)]);
    await this.jobRepository.queueAll([...ids].map((id) => ({ name: JobName.AssetInferLocation, data: { id } })));
  }

  private async removeAccount(userId: string) {
    await this.keychainRepository.delete(SYNOLOGY_KEYCHAIN_SERVICE, userId);
    await this.synologyAlbumRepository.setUnmatched(userId, []);
    const accounts = await this.getAccounts();
    if (!accounts[userId]) {
      return;
    }

    delete accounts[userId];
    await this.saveAccounts(accounts);
    this.logger.log(`Removed the Synology account of user ${userId}`);
  }

  /** Logs in, reads who the account is in Synology Photos and how many albums it has, and logs out */
  private async connect(
    connection: SynologyConnection,
    account: string,
    secret: Secret,
    otpCode?: string,
  ): Promise<Connected | Failed> {
    const result = await this.withSession(
      connection,
      account,
      secret,
      (session) => this.countAlbums(connection, session.sid),
      otpCode,
    );
    if (!result.success) {
      return result;
    }

    return {
      success: true,
      secret: result.secret,
      photosUserId: result.me.id,
      dsmUserId: result.me.uid,
      name: result.me.name,
      albumCount: result.value,
    };
  }

  /** Logs in, does what is to be done with the session, and logs out, however that went */
  private async withSession<T>(
    connection: SynologyConnection,
    account: string,
    secret: Secret,
    fn: (session: Session) => Promise<T>,
    otpCode?: string,
  ): Promise<(Session & { value: T }) | Failed> {
    try {
      const session = await this.login(connection, account, secret, otpCode);
      if (!session.success) {
        return session;
      }

      try {
        return { ...session, value: await fn(session) };
      } finally {
        await this.synologyRepository
          .call(connection, 'SYNO.API.Auth', 'logout', session.version, { session: SESSION }, session.sid)
          .catch(() => {});
      }
    } catch (error) {
      if (error instanceof SynologyError) {
        return { success: false, reason: error.reason, message: error.message };
      }
      return { success: false, reason: SynologyErrorReason.Other, message: String(error) };
    }
  }

  /** Logs in, and reads who the account is in Synology Photos: once that fails, it is logged out again */
  private async login(
    connection: SynologyConnection,
    account: string,
    secret: Secret,
    otpCode?: string,
  ): Promise<Session | Failed> {
    const info = await this.synologyRepository.call(connection, 'SYNO.API.Info', 'query', 1, {
      query: 'SYNO.API.Auth,SYNO.Foto.',
    });
    const apis = info.success ? info.data : undefined;
    if (!apis?.['SYNO.API.Auth']) {
      return { success: false, reason: SynologyErrorReason.NotSynology, message: 'No Synology login API there' };
    }
    if (!apis['SYNO.Foto.Browse.Album'] || !apis['SYNO.Foto.UserInfo']) {
      return {
        success: false,
        reason: SynologyErrorReason.NoPhotos,
        message: 'The photo app is not installed on this NAS',
      };
    }

    const version = Math.min(apis['SYNO.API.Auth'].maxVersion ?? 6, 7);
    const login = await this.synologyRepository.call<{ sid: string; did?: string }>(
      connection,
      'SYNO.API.Auth',
      'login',
      version,
      {
        account,
        passwd: secret.password,
        session: SESSION,
        format: 'sid',
        device_name: SESSION,
        ...(otpCode ? { otp_code: otpCode, enable_device_token: 'yes' } : { device_id: secret.deviceId }),
      },
    );
    if (!login.success || !login.data?.sid) {
      const code = login.error?.code;
      return { success: false, reason: getAuthErrorReason(code), message: `The NAS answered with error ${code}` };
    }

    const sid = login.data.sid;
    const logout = () =>
      this.synologyRepository
        .call(connection, 'SYNO.API.Auth', 'logout', version, { session: SESSION }, sid)
        .catch(() => {});

    let me;
    try {
      me = await this.synologyRepository.call<{ id: number; uid?: number; name?: string }>(
        connection,
        'SYNO.Foto.UserInfo',
        'me',
        1,
        {},
        sid,
      );
    } catch (error) {
      await logout();
      throw error;
    }
    if (!me.success || typeof me.data?.id !== 'number') {
      await logout();
      return {
        success: false,
        reason: SynologyErrorReason.NoPhotos,
        message: `The account may not use the NAS photo app (error ${me.error?.code})`,
      };
    }

    return {
      success: true,
      sid,
      version,
      secret: { password: secret.password, deviceId: login.data.did || secret.deviceId },
      me: { id: me.data.id, uid: me.data.uid, name: me.data.name },
    };
  }

  private async countAlbums(connection: SynologyConnection, sid: string) {
    const albums = await this.list(connection, sid, 'SYNO.Foto.Browse.Album', 'list', 2);
    return albums.length;
  }

  /** All of a list, page by page */
  private async list<T>(
    connection: SynologyConnection,
    sid: string,
    api: string,
    method: string,
    version: number,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.synologyRepository.call<{ list: T[] }>(
        connection,
        api,
        method,
        version,
        { ...params, offset, limit: PAGE },
        sid,
      );
      if (!page.success) {
        throw new SynologyError(
          SynologyErrorReason.NoPhotos,
          `Could not list ${api.split('.').pop()?.toLowerCase()}s (error ${page.error?.code})`,
        );
      }

      const list = page.data?.list ?? [];
      all.push(...list);
      if (list.length < PAGE) {
        return all;
      }
    }
  }

  /** Keeps the token a login with a 2-step verification code returned, which spares the next one a code */
  private async keepSecret(userId: string, before: Secret | null, after: Secret) {
    if (after.deviceId === before?.deviceId) {
      return;
    }

    await this.keychainRepository
      .set(SYNOLOGY_KEYCHAIN_SERVICE, userId, JSON.stringify(after))
      .catch((error) => this.logger.warn(`Could not keep the Synology device token: ${error}`));
  }

  private async readSecret(userId: string): Promise<Secret | null> {
    const value = await this.keychainRepository.get(SYNOLOGY_KEYCHAIN_SERVICE, userId);
    if (!value) {
      return null;
    }

    const secret = JSON.parse(value) as Secret;
    return typeof secret?.password === 'string' ? secret : null;
  }

  private failed({ reason, message }: Failed, current?: SynologyAccount): SynologyAccountTestResponseDto {
    return { success: false, errorReason: reason, message, account: this.map(current) };
  }

  private map(account?: SynologyAccount): SynologyAccountResponseDto {
    if (!account) {
      return { bound: false };
    }

    const { url, account: name, verifyCertificate, boundAt, checkedAt, albumCount, error, lastSync } = account;
    const now = new Date();
    const autoSync = account.autoSync !== false;
    const syncTime = account.syncTime ?? SYNOLOGY_SYNC_TIME;
    const queuedAt = account.syncQueuedAt ? Date.parse(account.syncQueuedAt) : 0;
    const syncPending =
      !!queuedAt && now.getTime() - queuedAt < PENDING_FOR && (!lastSync || Date.parse(lastSync.startedAt) < queuedAt);

    return {
      bound: true,
      url,
      account: name,
      verifyCertificate,
      name: account.name,
      boundAt,
      checkedAt,
      albumCount,
      errorReason: error?.reason,
      message: error?.message,
      autoSync,
      syncTime,
      nextSyncAt: autoSync ? getNextScheduled(syncTime, now).toISOString() : undefined,
      syncPending,
      lastSync,
    };
  }

  private async getAccounts(): Promise<Record<string, SynologyAccount>> {
    const value = await this.systemMetadataRepository.get(SystemMetadataKey.SynologyAccounts);
    return value?.users ?? {};
  }

  private async getUserAccount(userId: string): Promise<SynologyAccount | undefined> {
    const accounts = await this.getAccounts();
    return accounts[userId];
  }

  private async saveAccounts(users: Record<string, SynologyAccount>) {
    await this.systemMetadataRepository.set(SystemMetadataKey.SynologyAccounts, { users });
  }

  /** The Keychain is there when the server runs natively on macOS, as network shares are */
  private isSupported() {
    return isNetworkSharesSupported(this.configRepository.getEnv().storage.networkSharesLocation);
  }

  private requireSupport() {
    if (!this.isSupported()) {
      throw new BadRequestException('External albums are only available when Immich runs natively on macOS');
    }
  }
}
