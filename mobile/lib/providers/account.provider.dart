import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/account.dart';
import 'package:immich_mobile/domain/models/account.model.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';

/// The devices logged in to the user's account, this one first
final authSessionsProvider = FutureProvider.autoDispose<List<AuthSession>>(
  (ref) => ref.watch(accountApiRepositoryProvider).getSessions(),
);

final accountServiceProvider = Provider((ref) => AccountService(ref));

/// Changes to the user's own account, and what shows them
class AccountService {
  final Ref _ref;

  const AccountService(this._ref);

  AccountApiRepository get _api => _ref.read(accountApiRepositoryProvider);

  Future<void> updateName(String name) async {
    await _api.updateMe(name: name);
    await _refreshUser();
  }

  /// Throws an [AccountException]: [AccountError.currentPasswordRequired] when the server wants [currentPassword],
  /// [AccountError.wrongPassword], [AccountError.emailNotAvailable]
  Future<void> updateEmail(String email, {String? currentPassword}) async {
    await _api.updateMe(email: email, currentPassword: currentPassword);
    await _refreshUser();
  }

  /// Logs out the other devices; throws an [AccountException] with [AccountError.wrongPassword]
  Future<void> changePassword({required String currentPassword, required String newPassword}) async {
    await _api.changePassword(currentPassword: currentPassword, newPassword: newPassword);
    _ref.invalidate(authSessionsProvider);
  }

  Future<void> logOutSession(String id) async {
    await _api.deleteSession(id);
    _ref.invalidate(authSessionsProvider);
  }

  Future<void> logOutOtherSessions() async {
    await _api.deleteOtherSessions();
    _ref.invalidate(authSessionsProvider);
  }

  /// The changed user, for what shows them (the stored user, and the auth state's copy)
  Future<void> _refreshUser() async {
    final user = await _ref.read(userServiceProvider).refreshMyUser();
    if (user != null) {
      _ref.read(authProvider.notifier).updateUserProfile(name: user.name, email: user.email);
    }
  }
}
