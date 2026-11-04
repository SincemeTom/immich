import {
  SynologyErrorReason,
  getAuthErrorReason,
  getConnectionErrorReason,
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
