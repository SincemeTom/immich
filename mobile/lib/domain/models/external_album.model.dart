/// Why connecting to the NAS of the external albums, or logging in to it, failed
enum ExternalAlbumError {
  unreachable,
  certificate,
  notSynology,
  noPhotos,
  wrongPassword,
  disabled,
  denied,
  otpRequired,
  otpWrong,
  otpEnforced,
  blocked,
  passwordExpired,
  alreadyBound,
  keychain,
  other;

  /// The reason the server gave; [other] for one this app does not know yet
  static ExternalAlbumError parse(String? value) =>
      values.firstWhere((reason) => reason.name == value, orElse: () => ExternalAlbumError.other);

  /// The NAS wants a 2-step verification code (again)
  bool get asksForCode => this == otpRequired || this == otpWrong;
}

/// Why a photo of an external album, or the album, was not matched in Immich
enum ExternalAlbumUnmatchedReason {
  notFound,
  ambiguous,
  ownerWaiting,
  albumEmpty,
  albumFailed;

  static ExternalAlbumUnmatchedReason parse(String value) =>
      values.firstWhere((reason) => reason.name == value, orElse: () => ExternalAlbumUnmatchedReason.notFound);

  /// About the whole album, not one of its photos
  bool get isAlbum => this == albumEmpty || this == albumFailed;
}

/// What the last sync of the external albums did
class ExternalAlbumSyncReport {
  final bool success;
  final DateTime finishedAt;
  final ExternalAlbumError? errorReason;
  final String? message;
  final int albums;
  final int albumsCreated;
  final int albumsUpdated;
  final int albumsRemoved;
  final int albumsEmpty;
  final int albumsFailed;
  final int items;
  final int matched;
  final int matchedByName;
  final int ambiguous;
  final int added;
  final int removed;
  final int others;
  final int othersMatched;
  final int othersWaiting;
  final int membersAdded;
  final int membersUpdated;
  final int membersRemoved;
  final int membersWaiting;
  final int unmatched;

  const ExternalAlbumSyncReport({
    required this.success,
    required this.finishedAt,
    this.errorReason,
    this.message,
    this.albums = 0,
    this.albumsCreated = 0,
    this.albumsUpdated = 0,
    this.albumsRemoved = 0,
    this.albumsEmpty = 0,
    this.albumsFailed = 0,
    this.items = 0,
    this.matched = 0,
    this.matchedByName = 0,
    this.ambiguous = 0,
    this.added = 0,
    this.removed = 0,
    this.others = 0,
    this.othersMatched = 0,
    this.othersWaiting = 0,
    this.membersAdded = 0,
    this.membersUpdated = 0,
    this.membersRemoved = 0,
    this.membersWaiting = 0,
    this.unmatched = 0,
  });
}

/// The user's NAS account for external albums, and how its albums are synced
class ExternalAlbumAccount {
  static const defaultSyncTime = '03:00';

  final bool bound;
  final String? url;
  final String? account;
  final bool verifyCertificate;
  final int? albumCount;
  final DateTime? checkedAt;
  final ExternalAlbumError? errorReason;
  final String? message;
  final bool autoSync;

  /// HH:mm, in the server's time zone
  final String syncTime;
  final DateTime? nextSyncAt;
  final bool syncPending;
  final ExternalAlbumSyncReport? lastSync;

  const ExternalAlbumAccount({
    required this.bound,
    this.url,
    this.account,
    this.verifyCertificate = true,
    this.albumCount,
    this.checkedAt,
    this.errorReason,
    this.message,
    this.autoSync = true,
    this.syncTime = defaultSyncTime,
    this.nextSyncAt,
    this.syncPending = false,
    this.lastSync,
  });

  static const unbound = ExternalAlbumAccount(bound: false);
}

/// Binding or testing the account: whether the NAS let Immich in, and the account as it is now
class ExternalAlbumResult {
  final bool success;
  final int? albumCount;
  final ExternalAlbumError? errorReason;
  final String? message;
  final ExternalAlbumAccount account;

  const ExternalAlbumResult({
    required this.success,
    required this.account,
    this.albumCount,
    this.errorReason,
    this.message,
  });
}

/// A photo of an external album, or the album, the last sync did not match
class ExternalAlbumUnmatched {
  final int albumId;
  final String albumName;
  final ExternalAlbumUnmatchedReason reason;

  /// Whether the user added the photo to the album, or another member did
  final bool mine;

  /// The photo, as its path on the NAS; none for an album
  final String? path;

  const ExternalAlbumUnmatched({
    required this.albumId,
    required this.albumName,
    required this.reason,
    required this.mine,
    this.path,
  });
}
