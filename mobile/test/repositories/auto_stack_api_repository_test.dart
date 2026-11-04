import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart';
import 'package:immich_mobile/data/server/auto_stack.dart';
import 'package:immich_mobile/domain/models/auto_stack.model.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class _MockUsersApi extends Mock implements UsersApi {}

class _MockStacksApi extends Mock implements StacksApi {}

void main() {
  late _MockUsersApi usersApi;
  late _MockStacksApi stacksApi;
  late AutoStackApiRepository sut;

  const autoStack = {
    'enabled': true,
    'burst': true,
    'rawJpeg': false,
    'edited': true,
    'similar': true,
    'maxDistance': 0.1,
    'maxSeconds': 30,
    'anytime': false,
    'anytimeDistance': 0.02,
  };
  const settings = AutoStackSettings(
    enabled: true,
    burst: true,
    rawJpeg: false,
    edited: true,
    similar: true,
    maxDistance: 0.1,
    maxSeconds: 30,
    anytime: false,
    anytimeDistance: 0.02,
  );

  setUpAll(() {
    registerFallbackValue(UserPreferencesUpdateDto());
    registerFallbackValue(AutoStackRunDto());
  });

  setUp(() {
    usersApi = _MockUsersApi();
    stacksApi = _MockStacksApi();
    sut = AutoStackApiRepository(usersApi, stacksApi);
  });

  void stubPreferences(Map<String, Object?> body) {
    when(
      () => usersApi.getMyPreferencesWithHttpInfo(),
    ).thenAnswer((_) async => Response.bytes(utf8.encode(jsonEncode(body)), 200));
  }

  test('reads the settings the server has', () async {
    stubPreferences({'autoStack': autoStack, 'memories': {}});

    expect(await sut.getSettings(), settings);
  });

  test('is null on a server without automatic stacking (an official one)', () async {
    stubPreferences({'memories': {}});

    expect(await sut.getSettings(), isNull);
  });

  test('saves every setting', () async {
    UserPreferencesUpdateDto? sent;
    when(() => usersApi.updateMyPreferences(any())).thenAnswer((invocation) async {
      sent = invocation.positionalArguments.first as UserPreferencesUpdateDto;
      return UserPreferencesResponseDto.fromJson({
        'albums': {'defaultAssetOrder': 'desc'},
        'autoStack': autoStack,
        'cast': {'gCastEnabled': false},
        'download': {'archiveSize': 1, 'includeEmbeddedVideos': false},
        'emailNotifications': {'albumInvite': true, 'albumUpdate': true, 'enabled': true},
        'folders': {'enabled': false, 'sidebarWeb': false},
        'memories': {'duration': 5, 'enabled': true, 'sidebarWeb': false},
        'people': {'enabled': true, 'sidebarWeb': false, 'updateStrategy': 'everyone'},
        'purchase': {'hideBuyButtonUntil': '', 'showSupportBadge': false},
        'ratings': {'enabled': false},
        'recentlyAdded': {'sidebarWeb': false},
        'sharedLinks': {'enabled': true, 'sidebarWeb': false},
        'tags': {'enabled': false, 'sidebarWeb': false},
      });
    });

    expect(await sut.updateSettings(settings), settings);
    expect(sent!.autoStack.orElse(null)!.toJson(), autoStack);
  });

  test('removing tells how many stacks went', () async {
    when(() => stacksApi.removeAutoStacks()).thenAnswer((_) async => AutoStackRemoveResponseDto(count: 4));

    expect(await sut.removeAll(), 4);
  });
}
