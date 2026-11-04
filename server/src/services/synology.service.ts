import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { SynologyConnection } from 'src/repositories/synology.repository.js';
import type { SynologyAccount } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  SynologyAccountBindDto,
  SynologyAccountResponseDto,
  SynologyAccountTestResponseDto,
} from 'src/dtos/synology.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { isNetworkSharesSupported } from 'src/utils/network-share.js';
import { SynologyError, SynologyErrorReason, getAuthErrorReason, toSynologyUrl } from 'src/utils/synology.js';

/** The Keychain items: this service, and the Immich user's ID as the account */
export const SYNOLOGY_KEYCHAIN_SERVICE = 'Immich Synology';
/** The name of the session on Synology, and of this server in the account's trusted devices */
const SESSION = 'Immich';
const PAGE = 500;

/** What is kept in the Keychain: the password, and the token that spares 2-step verification codes */
type Secret = { password: string; deviceId?: string };

type Connected = {
  success: true;
  secret: Secret;
  photosUserId: number;
  dsmUserId?: number;
  name?: string;
  albumCount: number;
};
type Failed = { success: false; reason: SynologyErrorReason; message: string };

/**
 * Each user binds their own Synology account, which the album sync reads Synology Photos with. Binding logs in
 * first: an account is only kept when the login works. The password goes into the macOS Keychain; the database keeps
 * the address, the account name and what the last login found.
 */
@Injectable()
export class SynologyService extends BaseService {
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
      throw new BadRequestException('Enter the password of the Synology account');
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
          message: 'Another Immich user bound this Synology account',
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
    };
    await this.saveAccounts({ ...accounts, [auth.user.id]: account });
    this.logger.log(`User ${auth.user.id} bound Synology account ${dto.account} at ${url}`);

    return { success: true, albumCount: result.albumCount, account: this.map(account) };
  }

  async testAccount(auth: AuthDto): Promise<SynologyAccountTestResponseDto> {
    this.requireSupport();
    const current = await this.getUserAccount(auth.user.id);
    if (!current) {
      throw new NotFoundException('No Synology account is bound');
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

    if (result.success && result.secret.deviceId !== secret?.deviceId) {
      await this.keychainRepository
        .set(SYNOLOGY_KEYCHAIN_SERVICE, auth.user.id, JSON.stringify(result.secret))
        .catch((error) => this.logger.warn(`Could not keep the Synology device token: ${error}`));
    }

    // read again, as logging in took a while; and the account may have been unbound meanwhile
    const accounts = await this.getAccounts();
    const account = accounts[auth.user.id];
    if (!account) {
      throw new NotFoundException('No Synology account is bound');
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

  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    if (!this.isSupported()) {
      return;
    }

    await this.removeAccount(id).catch((error) =>
      this.logger.warn(`Could not remove the Synology account of user ${id}: ${error}`),
    );
  }

  private async removeAccount(userId: string) {
    await this.keychainRepository.delete(SYNOLOGY_KEYCHAIN_SERVICE, userId);
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
    try {
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
          message: 'Synology Photos is not installed on this Synology',
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
        return { success: false, reason: getAuthErrorReason(code), message: `Synology answered with error ${code}` };
      }

      const sid = login.data.sid;
      try {
        const me = await this.synologyRepository.call<{ id: number; uid?: number; name?: string }>(
          connection,
          'SYNO.Foto.UserInfo',
          'me',
          1,
          {},
          sid,
        );
        if (!me.success || typeof me.data?.id !== 'number') {
          return {
            success: false,
            reason: SynologyErrorReason.NoPhotos,
            message: `The account may not use Synology Photos (error ${me.error?.code})`,
          };
        }

        const albumCount = await this.countAlbums(connection, sid);
        return {
          success: true,
          secret: { password: secret.password, deviceId: login.data.did || secret.deviceId },
          photosUserId: me.data.id,
          dsmUserId: me.data.uid,
          name: me.data.name,
          albumCount,
        };
      } finally {
        await this.synologyRepository
          .call(connection, 'SYNO.API.Auth', 'logout', version, { session: SESSION }, sid)
          .catch(() => {});
      }
    } catch (error) {
      if (error instanceof SynologyError) {
        return { success: false, reason: error.reason, message: error.message };
      }
      return { success: false, reason: SynologyErrorReason.Other, message: String(error) };
    }
  }

  private async countAlbums(connection: SynologyConnection, sid: string) {
    let count = 0;
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.synologyRepository.call<{ list: unknown[] }>(
        connection,
        'SYNO.Foto.Browse.Album',
        'list',
        2,
        { offset, limit: PAGE },
        sid,
      );
      if (!page.success) {
        throw new SynologyError(SynologyErrorReason.NoPhotos, `Could not list albums (error ${page.error?.code})`);
      }

      const length = page.data?.list?.length ?? 0;
      count += length;
      if (length < PAGE) {
        return count;
      }
    }
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

    const { url, account: name, verifyCertificate, boundAt, checkedAt, albumCount, error } = account;
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
      throw new BadRequestException('Synology accounts are only available when Immich runs natively on macOS');
    }
  }
}
