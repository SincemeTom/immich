import type { SynologyLibraryAsset } from 'src/repositories/synology-album.repository.js';
import type { SynologyAccount } from 'src/types.js';
import {
  SynologyErrorReason,
  SynologyPathIndex,
  getAuthErrorReason,
  getConnectionErrorReason,
  getLastScheduled,
  getNextScheduled,
  isSynologySyncDue,
  isSynologySyncTime,
  toSynologyPath,
  toSynologyUrl,
} from 'src/utils/synology.js';

describe('toSynologyUrl', () => {
  it.each([
    ['https://nas.example.com:5001', 'https://nas.example.com:5001'],
    ['nas.example.com:5001', 'https://nas.example.com:5001'],
    ['  NAS.example.com  ', 'https://nas.example.com'],
    ['https://nas.example.com:5001/photo/#/album', 'https://nas.example.com:5001'],
    ['https://nas.example.com:443', 'https://nas.example.com'],
    ['http://192.168.1.10:5000', 'http://192.168.1.10:5000'],
    ['192.168.1.10:5001', 'https://192.168.1.10:5001'],
    ['https://[fd00::10]:5001', 'https://[fd00::10]:5001'],
  ])('should make %s %s', (value, expected) => {
    expect(toSynologyUrl(value)).toBe(expected);
  });

  it.each([
    '',
    ' '.repeat(3),
    'ftp://nas.example.com',
    'https://user:pw@nas.example.com',
    'https://',
    'not a host name',
  ])('should refuse %j', (value) => {
    expect(toSynologyUrl(value)).toBeUndefined();
  });
});

describe('getAuthErrorReason', () => {
  it('should map the login errors', () => {
    expect(getAuthErrorReason(400)).toBe(SynologyErrorReason.WrongPassword);
    expect(getAuthErrorReason(403)).toBe(SynologyErrorReason.OtpRequired);
    expect(getAuthErrorReason(406)).toBe(SynologyErrorReason.OtpEnforced);
    expect(getAuthErrorReason(410)).toBe(SynologyErrorReason.PasswordExpired);
    expect(getAuthErrorReason(119)).toBe(SynologyErrorReason.Other);
    expect(getAuthErrorReason()).toBe(SynologyErrorReason.Other);
  });
});

describe('getConnectionErrorReason', () => {
  it('should tell a certificate problem from no answer', () => {
    expect(getConnectionErrorReason('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe(SynologyErrorReason.Certificate);
    expect(getConnectionErrorReason('ERR_TLS_CERT_ALTNAME_INVALID')).toBe(SynologyErrorReason.Certificate);
    expect(getConnectionErrorReason('EPROTO')).toBe(SynologyErrorReason.NotSynology);
    expect(getConnectionErrorReason('ECONNREFUSED')).toBe(SynologyErrorReason.Unreachable);
    expect(getConnectionErrorReason('ENOTFOUND')).toBe(SynologyErrorReason.Unreachable);
    expect(getConnectionErrorReason()).toBe(SynologyErrorReason.Unreachable);
  });
});

describe('toSynologyPath', () => {
  it.each([
    ['/2023/Trip', 'a.jpg', '2023/Trip/a.jpg'],
    ['/', 'a.jpg', 'a.jpg'],
    ['', 'a.jpg', 'a.jpg'],
    ['/2023/', 'a.jpg', '2023/a.jpg'],
  ])('should make %s and %s %s', (folder, filename, expected) => {
    expect(toSynologyPath(folder, filename)).toBe(expected);
  });

  it('should compose names, as macOS may not', () => {
    expect(toSynologyPath('/Cafe\u{301}', 'e\u{301}.jpg')).toBe('Caf\u{E9}/\u{E9}.jpg');
  });
});

const asset = (originalPath: string, overrides: Partial<SynologyLibraryAsset> = {}): SynologyLibraryAsset => ({
  id: originalPath,
  originalPath,
  isOffline: false,
  fileSizeInByte: 100,
  ...overrides,
});
const index = (...assets: SynologyLibraryAsset[]) => {
  const value = new SynologyPathIndex();
  for (const item of assets) {
    value.add(item);
  }
  return value;
};

describe(SynologyPathIndex.name, () => {
  it('should find a photo wherever the Photos folder is mounted', () => {
    const sut = index(asset('/mnt/home/Photos/2023/Trip/a.jpg'), asset('/mnt/home/Photos/2024/a.jpg'));

    expect(sut.find('2023/Trip/a.jpg', 100)?.id).toBe('/mnt/home/Photos/2023/Trip/a.jpg');
    expect(sut.size).toBe(2);
  });

  it('should only match at a folder boundary', () => {
    const sut = index(asset('/mnt/Photos/x2023/Trip/a.jpg'));

    expect(sut.find('2023/Trip/a.jpg')).toBeUndefined();
  });

  it('should match a path written decomposed', () => {
    const sut = index(asset('/mnt/Photos/Cafe\u{301}/a.jpg'));

    expect(sut.find(toSynologyPath('/Caf\u{E9}', 'a.jpg'))).toBeDefined();
  });

  it('should match ignoring case, when no path is the same', () => {
    const sut = index(asset('/mnt/Photos/2023/IMG_1.JPG'));

    expect(sut.find('2023/img_1.jpg')?.id).toBe('/mnt/Photos/2023/IMG_1.JPG');
  });

  it('should prefer the same path over one of another case', () => {
    const sut = index(asset('/mnt/Photos/2023/IMG_1.JPG'), asset('/mnt/Photos/2023/IMG_1.jpg'));

    expect(sut.find('2023/IMG_1.jpg')?.id).toBe('/mnt/Photos/2023/IMG_1.jpg');
  });

  it('should prefer one of the same size, then one online', () => {
    const sut = index(
      asset('/a/Photos/2023/a.jpg', { fileSizeInByte: 1 }),
      asset('/b/Photos/2023/a.jpg', { isOffline: true }),
      asset('/c/Photos/2023/a.jpg'),
    );

    expect(sut.find('2023/a.jpg', 100)?.id).toBe('/c/Photos/2023/a.jpg');
    expect(sut.find('2023/a.jpg', 1)?.id).toBe('/a/Photos/2023/a.jpg');
  });

  it('should only take a photo directly in the Photos folder when its size is the same', () => {
    const sut = index(asset('/mnt/Photos/a.jpg', { fileSizeInByte: 1 }));

    expect(sut.find('a.jpg', 100)).toBeUndefined();
    expect(sut.find('a.jpg', 1)).toBeDefined();
  });

  it('should find nothing for a name it does not have', () => {
    expect(index(asset('/mnt/Photos/a.jpg')).find('2023/b.jpg')).toBeUndefined();
  });
});

describe('isSynologySyncTime', () => {
  it.each(['00:00', '03:00', '23:59'])('should take %s', (value) => {
    expect(isSynologySyncTime(value)).toBe(true);
  });

  it.each(['3:00', '24:00', '12:60', '', '03:00:00'])('should not take %s', (value) => {
    expect(isSynologySyncTime(value)).toBe(false);
  });
});

describe('getLastScheduled', () => {
  it('should be today once the time came round, else yesterday', () => {
    expect(getLastScheduled('03:00', new Date(2026, 10, 5, 3, 0))).toEqual(new Date(2026, 10, 5, 3, 0));
    expect(getLastScheduled('03:00', new Date(2026, 10, 5, 2, 59))).toEqual(new Date(2026, 10, 4, 3, 0));
    expect(getNextScheduled('03:00', new Date(2026, 10, 5, 3, 0))).toEqual(new Date(2026, 10, 6, 3, 0));
  });
});

const account = (overrides: Partial<SynologyAccount> = {}): SynologyAccount => ({
  url: 'https://nas.example.com:5001',
  verifyCertificate: true,
  account: 'alice',
  photosUserId: 1,
  boundAt: new Date(2026, 10, 1, 12).toISOString(),
  checkedAt: new Date(2026, 10, 1, 12).toISOString(),
  ...overrides,
});

describe('isSynologySyncDue', () => {
  it('should be due at 03:00 unless set otherwise', () => {
    expect(isSynologySyncDue(account(), new Date(2026, 10, 2, 3, 0))).toBe(true);
    expect(isSynologySyncDue(account(), new Date(2026, 10, 2, 2, 59))).toBe(false);
    expect(isSynologySyncDue(account({ syncTime: '04:00' }), new Date(2026, 10, 2, 3, 30))).toBe(false);
  });

  it('should not be due when turned off', () => {
    expect(isSynologySyncDue(account({ autoSync: false }), new Date(2026, 10, 9))).toBe(false);
  });

  it('should not be due again once queued', () => {
    const queued = account({ syncQueuedAt: new Date(2026, 10, 2, 3, 0).toISOString() });

    expect(isSynologySyncDue(queued, new Date(2026, 10, 2, 3, 1))).toBe(false);
    expect(isSynologySyncDue(queued, new Date(2026, 10, 3, 3, 0))).toBe(true);
  });
});
