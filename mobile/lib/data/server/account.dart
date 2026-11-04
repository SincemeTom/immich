import 'dart:convert';
import 'dart:io';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/account.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final accountApiRepositoryProvider = Provider((ref) {
  final api = ref.watch(apiServiceProvider);
  return AccountApiRepository(api.usersApi, api.authenticationApi, api.sessionsApi);
});

/// The user's own account: name, login email, password, and the devices logged in to it
class AccountApiRepository extends ApiRepository {
  final UsersApi _usersApi;
  final AuthenticationApi _authApi;
  final SessionsApi _sessionsApi;

  const AccountApiRepository(this._usersApi, this._authApi, this._sessionsApi);

  /// Change the name and/or the login email. The fork's server wants [currentPassword] to change the email (an
  /// [AccountException] with [AccountError.currentPasswordRequired] tells it); official servers take it without.
  Future<void> updateMe({String? name, String? email, String? currentPassword}) {
    return _accountErrors(
      () => checkNull(
        _usersApi.updateMyUser(
          UserUpdateMeDto(
            name: name == null ? const Optional.absent() : Optional.present(name),
            email: email == null ? const Optional.absent() : Optional.present(email),
            currentPassword: currentPassword == null ? const Optional.absent() : Optional.present(currentPassword),
          ),
        ),
      ),
    );
  }

  /// The server then logs out the user's other devices; this one stays
  Future<void> changePassword({required String currentPassword, required String newPassword}) {
    return _accountErrors(
      () => _authApi.changePassword(ChangePasswordDto(password: currentPassword, newPassword: newPassword)),
    );
  }

  /// This device first, then the most recently used
  Future<List<AuthSession>> getSessions() async {
    final sessions = [
      for (final dto in await checkNull(_sessionsApi.getSessions()))
        AuthSession(
          id: dto.id,
          createdAt: DateTime.parse(dto.createdAt).toLocal(),
          updatedAt: DateTime.parse(dto.updatedAt).toLocal(),
          current: dto.current,
          deviceOS: dto.deviceOS,
          deviceType: dto.deviceType,
          appVersion: dto.appVersion,
        ),
    ];
    return sessions..sort((a, b) {
      if (a.current != b.current) {
        return a.current ? -1 : 1;
      }
      return b.updatedAt.compareTo(a.updatedAt);
    });
  }

  Future<void> deleteSession(String id) => _sessionsApi.deleteSession(id);

  /// Every session but this one
  Future<void> deleteOtherSessions() => _sessionsApi.deleteAllSessions();

  Future<void> _accountErrors(Future<Object?> Function() call) async {
    try {
      await call();
    } on ApiException catch (error) {
      final known = error.code == HttpStatus.badRequest ? _accountError(_message(error)) : null;
      if (known == null) {
        rethrow;
      }
      throw AccountException(known);
    }
  }

  static String? _message(ApiException error) {
    try {
      final body = jsonDecode(error.message ?? '');
      return body is Map ? body['message']?.toString() : null;
    } on FormatException {
      return null;
    }
  }

  static AccountError? _accountError(String? message) => switch (message) {
    'Current password is required' => AccountError.currentPasswordRequired,
    'Wrong password' => AccountError.wrongPassword,
    'Email is not available' => AccountError.emailNotAvailable,
    _ => null,
  };
}
