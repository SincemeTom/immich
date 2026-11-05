import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/openapi_patching.dart';
import 'package:openapi/api.dart';

void main() {
  group('Test OpenApi Patching', () {
    test('upgradeDto', () {
      dynamic value;
      String targetType;

      targetType = 'UserPreferencesResponseDto';
      value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");

      upgradeDto(value, targetType);
      expect(value['tags'], TagsResponse(enabled: false, sidebarWeb: false).toJson());
      expect(value['download']['includeEmbeddedVideos'], false);
    });

    test('addDefault', () {
      final dynamic value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");
      String keys = 'download.unknownKey';
      dynamic defaultValue = 69420;

      addDefault(value, keys, defaultValue);
      expect(value['download']['unknownKey'], 69420);

      keys = 'alpha.beta';
      defaultValue = 'gamma';
      addDefault(value, keys, defaultValue);
      expect(value['alpha']['beta'], 'gamma');
    });

    test('addDefault with null', () {
      final dynamic value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");
      expect(value['download']['unknownKey'], isNull);
    });
  });

  group('Pixcellar: official servers lack the fork fields', () {
    test('an album member', () {
      final member = AlbumUserResponseDto.fromJson({
        'role': 'viewer',
        'user': {
          'id': 'u1',
          'email': 'a@example.com',
          'name': 'A',
          'profileImagePath': '',
          'avatarColor': 'primary',
          'profileChangedAt': '2026-01-01T00:00:00.000Z',
        },
      })!;
      expect(member.role, AlbumUserRole.viewer);
      expect(member.allowDownload, isTrue);
      expect(member.isManager, isFalse);
    });

    test('the server features', () {
      final features = ServerFeaturesDto.fromJson(
        {for (final key in ServerFeaturesDto.requiredKeys) key: true}..remove('networkShares'),
      )!;
      expect(features.networkShares, isFalse);
    });

    test('two queues lists, the second one not touching the first', () {
      Map<String, dynamic> queues() => {
        for (final key in QueuesResponseLegacyDto.requiredKeys)
          key: {
            'jobCounts': {'active': 1, 'completed': 0, 'delayed': 0, 'failed': 0, 'paused': 0, 'waiting': 0},
            'queueStatus': {'isActive': true, 'isPaused': false},
          },
      }..removeWhere((key, _) => const {'autoStack', 'contentAnalysis', 'locationInference'}.contains(key));
      final first = QueuesResponseLegacyDto.fromJson(queues())!;
      final second = QueuesResponseLegacyDto.fromJson(queues())!;
      expect(first.autoStack.queueStatus.isActive, isFalse);
      expect(second.locationInference.jobCounts.active, 0);
    });
  });
}
