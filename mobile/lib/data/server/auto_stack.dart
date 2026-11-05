import 'dart:convert';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/auto_stack.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final autoStackApiRepositoryProvider = Provider((ref) {
  final api = ref.watch(apiServiceProvider);
  return AutoStackApiRepository(api.usersApi, api.stacksApi);
});

/// The user's automatic stacking, on the fork's server
class AutoStackApiRepository extends ApiRepository {
  final UsersApi _usersApi;
  final StacksApi _stacksApi;

  const AutoStackApiRepository(this._usersApi, this._stacksApi);

  /// Null when the server does not stack photos automatically (an official server): its preferences do not have it
  Future<AutoStackSettings?> getSettings() async {
    final response = await _usersApi.getMyPreferencesWithHttpInfo();
    if (response.statusCode >= 400) {
      throw ApiException(response.statusCode, response.body);
    }
    final json = jsonDecode(utf8.decode(response.bodyBytes));
    final autoStack = json is Map ? AutoStackResponse.fromJson(json['autoStack']) : null;
    return autoStack == null ? null : _fromDto(autoStack);
  }

  Future<AutoStackSettings> updateSettings(AutoStackSettings settings) async {
    final preferences = await checkNull(
      _usersApi.updateMyPreferences(
        UserPreferencesUpdateDto(
          autoStack: Optional.present(
            AutoStackUpdate(
              enabled: Optional.present(settings.enabled),
              burst: Optional.present(settings.burst),
              rawJpeg: Optional.present(settings.rawJpeg),
              edited: Optional.present(settings.edited),
              similar: Optional.present(settings.similar),
              maxDistance: Optional.present(settings.maxDistance),
              maxSeconds: Optional.present(settings.maxSeconds),
              anytime: Optional.present(settings.anytime),
              anytimeDistance: Optional.present(settings.anytimeDistance),
            ),
          ),
        ),
      ),
    );
    return _fromDto(preferences.autoStack);
  }

  /// Stacks the user's photos now, in the background on the server
  Future<void> run() => _stacksApi.runAutoStack(AutoStackRunDto());

  /// Removes the stacks made automatically, keeping their photos. Returns how many
  Future<int> removeAll() async => (await _stacksApi.removeAutoStacks())?.count ?? 0;

  static AutoStackSettings _fromDto(AutoStackResponse dto) => AutoStackSettings(
    enabled: dto.enabled,
    burst: dto.burst,
    rawJpeg: dto.rawJpeg,
    edited: dto.edited,
    similar: dto.similar,
    maxDistance: dto.maxDistance,
    maxSeconds: dto.maxSeconds,
    anytime: dto.anytime,
    anytimeDistance: dto.anytimeDistance,
  );
}
