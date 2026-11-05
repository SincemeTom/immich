import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/server/account.dart';
import 'package:immich_mobile/domain/models/account.model.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../../api.mocks.dart';

ApiException _badRequest(String message) =>
    ApiException(400, jsonEncode({'message': message, 'error': 'Bad Request', 'statusCode': 400}));

SessionResponseDto _session(String id, {required String updatedAt, bool current = false}) => SessionResponseDto(
  id: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: updatedAt,
  current: current,
  deviceOS: 'iOS',
  deviceType: 'iPhone14,5',
  appVersion: '3.3.5',
  isPendingSyncReset: false,
);

void main() {
  late MockUsersApi usersApi;
  late MockAuthenticationApi authApi;
  late MockSessionsApi sessionsApi;
  late AccountApiRepository sut;

  setUpAll(() {
    registerFallbackValue(UserUpdateMeDto());
    registerFallbackValue(ChangePasswordDto(newPassword: '', password: ''));
  });

  setUp(() {
    usersApi = MockUsersApi();
    authApi = MockAuthenticationApi();
    sessionsApi = MockSessionsApi();
    sut = AccountApiRepository(usersApi, authApi, sessionsApi);
  });

  group('updateMe', () {
    test('sends only what changes', () async {
      when(() => usersApi.updateMyUser(any())).thenThrow(_badRequest('stop'));

      await expectLater(
        sut.updateMe(email: 'new@example.com', currentPassword: 'secret'),
        throwsA(isA<ApiException>()),
      );

      final dto = verify(() => usersApi.updateMyUser(captureAny())).captured.single as UserUpdateMeDto;
      expect(dto.email.orElse(null), 'new@example.com');
      expect(dto.currentPassword.orElse(null), 'secret');
      expect(dto.name.isPresent, isFalse);
    });

    for (final (message, error) in [
      ('Current password is required', AccountError.currentPasswordRequired),
      ('Wrong password', AccountError.wrongPassword),
      ('Email is not available', AccountError.emailNotAvailable),
    ]) {
      test('tells "$message"', () async {
        when(() => usersApi.updateMyUser(any())).thenThrow(_badRequest(message));

        await expectLater(
          sut.updateMe(email: 'new@example.com'),
          throwsA(isA<AccountException>().having((exception) => exception.error, 'error', error)),
        );
      });
    }

    test('leaves other errors as they are', () async {
      when(() => usersApi.updateMyUser(any())).thenThrow(ApiException(500, 'boom'));

      await expectLater(sut.updateMe(name: 'Name'), throwsA(isA<ApiException>()));
    });
  });

  test('changePassword tells a wrong password', () async {
    when(() => authApi.changePassword(any())).thenThrow(_badRequest('Wrong password'));

    await expectLater(
      sut.changePassword(currentPassword: 'old', newPassword: 'new-password'),
      throwsA(isA<AccountException>().having((exception) => exception.error, 'error', AccountError.wrongPassword)),
    );
  });

  test('getSessions puts this device first, then the most recently used', () async {
    when(() => sessionsApi.getSessions()).thenAnswer(
      (_) async => [
        _session('old', updatedAt: '2026-01-02T00:00:00.000Z'),
        _session('mine', updatedAt: '2026-01-01T00:00:00.000Z', current: true),
        _session('recent', updatedAt: '2026-01-03T00:00:00.000Z'),
      ],
    );

    final sessions = await sut.getSessions();

    expect(sessions.map((session) => session.id), ['mine', 'recent', 'old']);
    expect(sessions.first.current, isTrue);
    expect(sessions.first.updatedAt, DateTime.utc(2026, 1, 1).toLocal());
  });
}
