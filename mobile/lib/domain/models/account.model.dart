/// A device or browser logged in to the user's account
class AuthSession {
  final String id;
  final DateTime createdAt;

  /// When it was last used
  final DateTime updatedAt;

  /// This app's own session
  final bool current;

  /// e.g. `iOS`, `Android`, `macOS`, `Mac OS` (a browser's)
  final String deviceOS;

  /// e.g. the phone's model, `Chrome`, `Safari`
  final String deviceType;
  final String? appVersion;

  const AuthSession({
    required this.id,
    required this.createdAt,
    required this.updatedAt,
    required this.current,
    required this.deviceOS,
    required this.deviceType,
    this.appVersion,
  });
}

enum AccountError {
  /// The server wants the current password for this change (the fork's, to change the login email)
  currentPasswordRequired,
  wrongPassword,

  /// Another account has this email
  emailNotAvailable,
}

class AccountException implements Exception {
  final AccountError error;

  const AccountException(this.error);

  @override
  String toString() => 'AccountException($error)';
}
