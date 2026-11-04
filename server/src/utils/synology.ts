/** Why connecting to Synology, or logging in to it, failed */
export enum SynologyErrorReason {
  /** no answer: a wrong address, the NAS is off, or a firewall */
  Unreachable = 'unreachable',
  /** the HTTPS certificate was not trusted */
  Certificate = 'certificate',
  /** something answered, but not the Synology Web API */
  NotSynology = 'notSynology',
  /** DSM answered, but Synology Photos is not installed, or the account may not use it */
  NoPhotos = 'noPhotos',
  WrongPassword = 'wrongPassword',
  Disabled = 'disabled',
  /** the account may not log in from here (DSM's application privileges) */
  Denied = 'denied',
  /** the account has 2-step verification on: a code is needed, once, after which this server is trusted */
  OtpRequired = 'otpRequired',
  OtpWrong = 'otpWrong',
  /** DSM requires the account to set up 2-step verification first */
  OtpEnforced = 'otpEnforced',
  /** DSM blocked this server's IP address, after too many failed logins */
  Blocked = 'blocked',
  PasswordExpired = 'passwordExpired',
  /** another Immich user bound the same Synology account */
  AlreadyBound = 'alreadyBound',
  /** the password could not be kept in, or read from, the macOS Keychain */
  Keychain = 'keychain',
  Other = 'other',
}

/** SYNO.API.Auth login's error codes (DSM Login Web API Guide) */
const AUTH_ERRORS: Record<number, SynologyErrorReason> = {
  400: SynologyErrorReason.WrongPassword,
  401: SynologyErrorReason.Disabled,
  402: SynologyErrorReason.Denied,
  403: SynologyErrorReason.OtpRequired,
  404: SynologyErrorReason.OtpWrong,
  406: SynologyErrorReason.OtpEnforced,
  407: SynologyErrorReason.Blocked,
  408: SynologyErrorReason.PasswordExpired,
  409: SynologyErrorReason.PasswordExpired,
  410: SynologyErrorReason.PasswordExpired,
};

export const getAuthErrorReason = (code?: number) =>
  (code === undefined ? undefined : AUTH_ERRORS[code]) ?? SynologyErrorReason.Other;

/**
 * The address of a Synology, as its origin: `https://nas.example.com:5001`. A path is dropped, as one pasted from the
 * browser's address bar may have one; the Web API is always at /webapi. HTTPS is assumed without a scheme.
 */
export const toSynologyUrl = (value: string): string | undefined => {
  const text = value.trim();
  if (!text) {
    return;
  }

  try {
    const url = new URL(/^[a-z][\d+.a-z-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return;
    }
    return url.origin;
  } catch {
    return;
  }
};

/** Node's TLS errors that mean the certificate was not trusted, rather than that nothing answered */
const CERTIFICATE_ERRORS = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** plain HTTP to the HTTPS port, or the other way round */
const PROTOCOL_ERRORS = new Set(['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'HPE_INVALID_CONSTANT']);

export const getConnectionErrorReason = (code?: string) => {
  if (code && CERTIFICATE_ERRORS.has(code)) {
    return SynologyErrorReason.Certificate;
  }
  if (code && PROTOCOL_ERRORS.has(code)) {
    return SynologyErrorReason.NotSynology;
  }
  return SynologyErrorReason.Unreachable;
};

export class SynologyError extends Error {
  constructor(
    public reason: SynologyErrorReason,
    message: string,
  ) {
    super(message);
  }
}
