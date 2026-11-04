import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { SynologyResponse } from 'src/repositories/synology.repository.js';
import type { SynologyAccount } from 'src/types.js';
import { SystemMetadataKey } from 'src/enum.js';
import { SYNOLOGY_KEYCHAIN_SERVICE, SynologyService } from 'src/services/synology.service.js';
import { SynologyError, SynologyErrorReason } from 'src/utils/synology.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const location = '/Users/me/Library/Application Support/Immich/mounts';
const url = 'https://nas.example.com:5001';

const apis = {
  'SYNO.API.Auth': { maxVersion: 7, minVersion: 1, path: 'entry.cgi' },
  'SYNO.Foto.Browse.Album': { maxVersion: 5, minVersion: 1, path: 'entry.cgi' },
  'SYNO.Foto.UserInfo': { maxVersion: 1, minVersion: 1, path: 'entry.cgi' },
};

const ok = <T>(data: T): SynologyResponse<T> => ({ success: true, data });
const fail = (code: number): SynologyResponse => ({ success: false, error: { code } });

const bound = (overrides: Partial<SynologyAccount> = {}): SynologyAccount => ({
  url,
  verifyCertificate: true,
  account: 'alice',
  photosUserId: 1,
  dsmUserId: 1026,
  name: 'alice',
  boundAt: '2026-11-01T00:00:00.000Z',
  checkedAt: '2026-11-01T00:00:00.000Z',
  albumCount: 3,
  ...overrides,
});

describe(SynologyService.name, () => {
  let sut: SynologyService;
  let mocks: ServiceMocks;
  let platform: PropertyDescriptor;
  let accounts: Record<string, SynologyAccount>;
  let keychain: Map<string, string>;
  /** replies by "api method", which may be functions of the parameters */
  let replies: Record<string, SynologyResponse | ((params: Record<string, unknown>) => SynologyResponse)>;
  let albums: number;

  const auth = factory.auth({ user: { id: 'user-1', email: 'alice@example.com' } });
  const called = (api: string, method: string) =>
    mocks.synology.call.mock.calls.filter((call) => call[1] === api && call[2] === method);

  beforeAll(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SynologyService));
    accounts = {};
    keychain = new Map();
    albums = 3;
    replies = {
      'SYNO.API.Info query': ok(apis),
      'SYNO.API.Auth login': ok({ sid: 'sid-1' }),
      'SYNO.API.Auth logout': ok({}),
      'SYNO.Foto.UserInfo me': ok({ id: 1, uid: 1026, name: 'alice' }),
      'SYNO.Foto.Browse.Album list': ({ offset }) => {
        const start = Number(offset);
        const length = Math.max(0, Math.min(500, albums - start));
        return ok({ list: Array.from({ length }, (_, index) => ({ id: start + index })) });
      },
    };

    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ storage: { ignoreMountCheckErrors: false, networkSharesLocation: location } }),
    );
    mocks.systemMetadata.get.mockImplementation(
      (key) =>
        Promise.resolve(
          key === SystemMetadataKey.SynologyAccounts ? { users: structuredClone(accounts) } : undefined,
        ) as any,
    );
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      if (key === SystemMetadataKey.SynologyAccounts) {
        accounts = structuredClone((value as { users: Record<string, SynologyAccount> }).users);
      }
      return Promise.resolve();
    });
    mocks.keychain.get.mockImplementation((service, account) =>
      Promise.resolve(keychain.get(`${service}/${account}`) ?? null),
    );
    mocks.keychain.set.mockImplementation((service, account, value) => {
      keychain.set(`${service}/${account}`, value);
      return Promise.resolve();
    });
    mocks.keychain.delete.mockImplementation((service, account) =>
      Promise.resolve(keychain.delete(`${service}/${account}`)),
    );
    mocks.synology.call.mockImplementation((_connection, api, method, _version, params = {}) => {
      const reply = replies[`${api} ${method}`];
      if (!reply) {
        return Promise.reject(new Error(`unexpected call ${api} ${method}`));
      }
      return Promise.resolve(typeof reply === 'function' ? reply(params) : reply);
    });
  });

  const secret = (userId = 'user-1') => {
    const value = keychain.get(`${SYNOLOGY_KEYCHAIN_SERVICE}/${userId}`);
    return value ? JSON.parse(value) : undefined;
  };

  it('should be there', () => {
    expect(sut).toBeDefined();
  });

  describe('when not on macOS', () => {
    it('should refuse, without touching the Keychain', async () => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ storage: { ignoreMountCheckErrors: false, networkSharesLocation: undefined } }),
      );

      await expect(sut.getAccount(auth)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.unbindAccount(auth)).rejects.toBeInstanceOf(BadRequestException);
      await sut.onUserDelete({ id: 'user-1' } as ArgOf<'UserDelete'>);
      expect(mocks.keychain.delete).not.toHaveBeenCalled();
    });
  });

  describe('getAccount', () => {
    it('should say when none is bound', async () => {
      await expect(sut.getAccount(auth)).resolves.toEqual({ bound: false });
    });

    it('should not give the password or device token', async () => {
      accounts['user-1'] = bound({ error: { reason: SynologyErrorReason.WrongPassword, message: 'error 400' } });
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'pw', deviceId: 'did' }));

      const account = await sut.getAccount(auth);

      expect(account).toEqual({
        bound: true,
        url,
        account: 'alice',
        verifyCertificate: true,
        name: 'alice',
        boundAt: '2026-11-01T00:00:00.000Z',
        checkedAt: '2026-11-01T00:00:00.000Z',
        albumCount: 3,
        errorReason: SynologyErrorReason.WrongPassword,
        message: 'error 400',
      });
      expect(JSON.stringify(account)).not.toContain('pw');
      expect(mocks.keychain.get).not.toHaveBeenCalled();
    });
  });

  describe('bindAccount', () => {
    it('should log in, keep the password in the Keychain and the rest in the database', async () => {
      albums = 1201;

      const result = await sut.bindAccount(auth, {
        url: 'nas.example.com:5001/photo/',
        account: 'alice',
        password: 'p@ss "w0rd"',
        verifyCertificate: false,
      });

      expect(result).toMatchObject({ success: true, albumCount: 1201, account: { bound: true, url, name: 'alice' } });
      expect(secret()).toEqual({ password: 'p@ss "w0rd"' });
      expect(mocks.keychain.set).toHaveBeenCalledWith(
        SYNOLOGY_KEYCHAIN_SERVICE,
        'user-1',
        expect.any(String),
        'Immich: Synology account of alice@example.com',
      );
      expect(accounts['user-1']).toMatchObject({
        url,
        verifyCertificate: false,
        account: 'alice',
        photosUserId: 1,
        dsmUserId: 1026,
        albumCount: 1201,
      });
      expect(JSON.stringify(accounts)).not.toContain('p@ss');
      expect(called('SYNO.Foto.Browse.Album', 'list').map((call) => call[4]?.offset)).toEqual([0, 500, 1000]);

      const login = called('SYNO.API.Auth', 'login')[0];
      const [connection, version, params] = [login[0], login[3], login[4]];
      expect(connection).toEqual({ url, verifyCertificate: false });
      expect(version).toBe(7);
      expect(params).toMatchObject({ account: 'alice', passwd: 'p@ss "w0rd"', session: 'Immich', format: 'sid' });
      expect(params).not.toHaveProperty('otp_code');
    });

    it('should log out after reading', async () => {
      await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(called('SYNO.API.Auth', 'logout')).toEqual([
        [{ url, verifyCertificate: true }, 'SYNO.API.Auth', 'logout', 7, { session: 'Immich' }, 'sid-1'],
      ]);
    });

    it('should log out when reading fails', async () => {
      replies['SYNO.Foto.UserInfo me'] = fail(105);

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result).toMatchObject({ success: false, errorReason: SynologyErrorReason.NoPhotos });
      expect(called('SYNO.API.Auth', 'logout')).toHaveLength(1);
      expect(keychain.size).toBe(0);
    });

    it.each([
      [400, SynologyErrorReason.WrongPassword],
      [401, SynologyErrorReason.Disabled],
      [402, SynologyErrorReason.Denied],
      [403, SynologyErrorReason.OtpRequired],
      [404, SynologyErrorReason.OtpWrong],
      [407, SynologyErrorReason.Blocked],
      [999, SynologyErrorReason.Other],
    ])('should keep nothing when the login fails with %s', async (code, reason) => {
      replies['SYNO.API.Auth login'] = fail(code);

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result).toEqual({
        success: false,
        errorReason: reason,
        message: `Synology answered with error ${code}`,
        account: { bound: false },
      });
      expect(mocks.keychain.set).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should keep the bound account as it was when binding another fails', async () => {
      accounts['user-1'] = bound();
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'old' }));
      replies['SYNO.API.Auth login'] = fail(400);

      const result = await sut.bindAccount(auth, {
        url,
        account: 'bob',
        password: 'pw',
        verifyCertificate: true,
      });

      expect(result).toMatchObject({ success: false, account: { bound: true, account: 'alice' } });
      expect(secret()).toEqual({ password: 'old' });
      expect(accounts['user-1']).toEqual(bound());
    });

    it('should tell when it is not a Synology', async () => {
      replies['SYNO.API.Info query'] = ok({});

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result).toMatchObject({ success: false, errorReason: SynologyErrorReason.NotSynology });
      expect(called('SYNO.API.Auth', 'login')).toHaveLength(0);
    });

    it('should tell when Synology Photos is not installed', async () => {
      replies['SYNO.API.Info query'] = ok({ 'SYNO.API.Auth': apis['SYNO.API.Auth'] });

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result).toMatchObject({ success: false, errorReason: SynologyErrorReason.NoPhotos });
      expect(called('SYNO.API.Auth', 'login')).toHaveLength(0);
    });

    it('should tell why the connection failed', async () => {
      mocks.synology.call.mockRejectedValue(
        new SynologyError(SynologyErrorReason.Certificate, 'self-signed certificate'),
      );

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result).toMatchObject({
        success: false,
        errorReason: SynologyErrorReason.Certificate,
        message: 'self-signed certificate',
      });
    });

    it('should use an older login API version on an older DSM', async () => {
      replies['SYNO.API.Info query'] = ok({ ...apis, 'SYNO.API.Auth': { maxVersion: 6 } });

      await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(called('SYNO.API.Auth', 'login')[0][3]).toBe(6);
    });

    it('should send the 2-step verification code, and keep the device token it gets', async () => {
      replies['SYNO.API.Auth login'] = ok({ sid: 'sid-1', did: 'device-token' });

      const result = await sut.bindAccount(auth, {
        url,
        account: 'alice',
        password: 'pw',
        verifyCertificate: true,
        otpCode: '123456',
      });

      expect(result.success).toBe(true);
      expect(called('SYNO.API.Auth', 'login')[0][4]).toMatchObject({
        otp_code: '123456',
        enable_device_token: 'yes',
        device_name: 'Immich',
      });
      expect(secret()).toEqual({ password: 'pw', deviceId: 'device-token' });
    });

    it('should log in with the device token instead of a code', async () => {
      accounts['user-1'] = bound();
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'pw', deviceId: 'device-token' }));

      await sut.bindAccount(auth, { url, account: 'alice', password: 'new', verifyCertificate: true });

      expect(called('SYNO.API.Auth', 'login')[0][4]).toMatchObject({ passwd: 'new', device_id: 'device-token' });
      expect(secret()).toEqual({ password: 'new', deviceId: 'device-token' });
    });

    it('should not use the device token of another account', async () => {
      accounts['user-1'] = bound();
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'pw', deviceId: 'device-token' }));

      await sut.bindAccount(auth, { url, account: 'bob', password: 'pw', verifyCertificate: true });

      expect(called('SYNO.API.Auth', 'login')[0][4]).not.toHaveProperty('device_id', 'device-token');
      expect(secret()).toEqual({ password: 'pw' });
    });

    it('should keep the password in the Keychain when only the certificate check changes', async () => {
      accounts['user-1'] = bound();
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'kept' }));

      const result = await sut.bindAccount(auth, { url, account: 'ALICE', verifyCertificate: false });

      expect(result.success).toBe(true);
      expect(called('SYNO.API.Auth', 'login')[0][4]).toMatchObject({ passwd: 'kept' });
      expect(accounts['user-1']).toMatchObject({ verifyCertificate: false, boundAt: '2026-11-01T00:00:00.000Z' });
    });

    it('should want a password for a new account', async () => {
      await expect(sut.bindAccount(auth, { url, account: 'alice', verifyCertificate: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.synology.call).not.toHaveBeenCalled();
    });

    it('should want a password when the address changes', async () => {
      accounts['user-1'] = bound();
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'kept' }));

      await expect(
        sut.bindAccount(auth, { url: 'https://other.example.com', account: 'alice', verifyCertificate: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should refuse an address that is not one', async () => {
      await expect(
        sut.bindAccount(auth, { url: 'ftp://nas', account: 'alice', password: 'pw', verifyCertificate: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should refuse an account another user bound', async () => {
      accounts['user-2'] = bound();

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result).toMatchObject({ success: false, errorReason: SynologyErrorReason.AlreadyBound });
      expect(mocks.keychain.set).not.toHaveBeenCalled();
      expect(accounts['user-1']).toBeUndefined();
    });

    it('should allow the same account name on another Synology', async () => {
      accounts['user-2'] = bound({ url: 'https://other.example.com' });

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result.success).toBe(true);
    });

    it('should not keep the account when the Keychain fails', async () => {
      mocks.keychain.set.mockRejectedValue(new Error('Could not write the Keychain item: locked'));

      const result = await sut.bindAccount(auth, { url, account: 'alice', password: 'pw', verifyCertificate: true });

      expect(result).toMatchObject({
        success: false,
        errorReason: SynologyErrorReason.Keychain,
        message: 'Error: Could not write the Keychain item: locked',
      });
      expect(accounts['user-1']).toBeUndefined();
    });
  });

  describe('testAccount', () => {
    beforeEach(() => {
      accounts['user-1'] = bound({ error: { reason: SynologyErrorReason.Unreachable, message: 'timeout' } });
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'pw', deviceId: 'device-token' }));
    });

    it('should want a bound account', async () => {
      accounts = {};

      await expect(sut.testAccount(auth)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should log in with what was kept, and clear the last error', async () => {
      albums = 49;

      const result = await sut.testAccount(auth);

      expect(result).toMatchObject({ success: true, albumCount: 49 });
      expect(result.account.errorReason).toBeUndefined();
      expect(result.account.message).toBeUndefined();
      expect(called('SYNO.API.Auth', 'login')[0][4]).toMatchObject({ passwd: 'pw', device_id: 'device-token' });
      expect(accounts['user-1']).toMatchObject({ albumCount: 49 });
      expect(accounts['user-1'].error).toBeUndefined();
      expect(accounts['user-1'].checkedAt).not.toBe('2026-11-01T00:00:00.000Z');
      expect(mocks.keychain.set).not.toHaveBeenCalled();
    });

    it('should keep the error, and the account', async () => {
      replies['SYNO.API.Auth login'] = fail(400);

      const result = await sut.testAccount(auth);

      expect(result).toMatchObject({
        success: false,
        errorReason: SynologyErrorReason.WrongPassword,
        account: { bound: true, errorReason: SynologyErrorReason.WrongPassword },
      });
      expect(accounts['user-1'].error).toEqual({
        reason: SynologyErrorReason.WrongPassword,
        message: 'Synology answered with error 400',
      });
      expect(secret()).toEqual({ password: 'pw', deviceId: 'device-token' });
    });

    it('should tell when the password is gone from the Keychain', async () => {
      keychain.clear();

      const result = await sut.testAccount(auth);

      expect(result).toMatchObject({ success: false, errorReason: SynologyErrorReason.Keychain });
      expect(mocks.synology.call).not.toHaveBeenCalled();
    });

    it('should tell when the Keychain cannot be read', async () => {
      mocks.keychain.get.mockRejectedValue(new Error('Could not read the Keychain item: locked'));

      const result = await sut.testAccount(auth);

      expect(result).toMatchObject({
        success: false,
        errorReason: SynologyErrorReason.Keychain,
        message: 'Error: Could not read the Keychain item: locked',
      });
      expect(mocks.synology.call).not.toHaveBeenCalled();
    });

    it('should keep a new device token', async () => {
      replies['SYNO.API.Auth login'] = ok({ sid: 'sid-1', did: 'new-token' });

      await sut.testAccount(auth);

      expect(secret()).toEqual({ password: 'pw', deviceId: 'new-token' });
    });

    it('should not bring back an account unbound while testing it', async () => {
      replies['SYNO.Foto.UserInfo me'] = () => {
        accounts = {};
        return ok({ id: 1 });
      };

      await expect(sut.testAccount(auth)).rejects.toBeInstanceOf(NotFoundException);
      expect(accounts).toEqual({});
    });
  });

  describe('unbindAccount', () => {
    it('should forget the account, and remove the password from the Keychain', async () => {
      accounts['user-1'] = bound();
      accounts['user-2'] = bound({ account: 'bob', photosUserId: 2 });
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'pw' }));

      await sut.unbindAccount(auth);

      expect(accounts).toEqual({ 'user-2': bound({ account: 'bob', photosUserId: 2 }) });
      expect(keychain.size).toBe(0);
    });

    it('should do nothing when none is bound', async () => {
      await sut.unbindAccount(auth);

      expect(mocks.keychain.delete).toHaveBeenCalledWith(SYNOLOGY_KEYCHAIN_SERVICE, 'user-1');
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should keep the account when the Keychain item cannot be removed', async () => {
      accounts['user-1'] = bound();
      mocks.keychain.delete.mockRejectedValue(new Error('locked'));

      await expect(sut.unbindAccount(auth)).rejects.toThrow('locked');
      expect(accounts['user-1']).toEqual(bound());
    });
  });

  describe('onUserDelete', () => {
    it('should remove the account of a deleted user', async () => {
      accounts['user-1'] = bound();
      keychain.set(`${SYNOLOGY_KEYCHAIN_SERVICE}/user-1`, JSON.stringify({ password: 'pw' }));

      await sut.onUserDelete({ id: 'user-1' } as ArgOf<'UserDelete'>);

      expect(accounts).toEqual({});
      expect(keychain.size).toBe(0);
    });

    it('should not fail the deletion', async () => {
      mocks.keychain.delete.mockRejectedValue(new Error('locked'));

      await expect(sut.onUserDelete({ id: 'user-1' } as ArgOf<'UserDelete'>)).resolves.toBeUndefined();
    });
  });
});
