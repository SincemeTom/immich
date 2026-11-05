import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/auto_stack.dart';
import 'package:immich_mobile/domain/models/auto_stack.model.dart';

/// The user's automatic stacking as saved on the server; null when the server does not have it
final autoStackSettingsProvider = FutureProvider.autoDispose<AutoStackSettings?>(
  (ref) => ref.watch(autoStackApiRepositoryProvider).getSettings(),
);

final autoStackServiceProvider = Provider((ref) => AutoStackService(ref));

/// Saving the user's automatic stacking, and stacking or unstacking their photos with it
class AutoStackService {
  final Ref _ref;

  const AutoStackService(this._ref);

  AutoStackApiRepository get _api => _ref.read(autoStackApiRepositoryProvider);

  /// Saves the settings, then stacks the existing photos with them when it is on. Returns whether it stacks them
  Future<bool> save(AutoStackSettings settings) async {
    await _api.updateSettings(settings);
    _ref.invalidate(autoStackSettingsProvider);
    if (!settings.enabled) {
      return false;
    }
    await _api.run();
    return true;
  }

  /// Saves the settings, removes the stacks made automatically, and stacks the photos again. Returns how many stacks
  /// were removed
  Future<int> redo(AutoStackSettings settings) async {
    await _api.updateSettings(settings);
    _ref.invalidate(autoStackSettingsProvider);
    final removed = await _api.removeAll();
    await _api.run();
    return removed;
  }

  /// Removes the stacks made automatically, keeping their photos. Returns how many
  Future<int> removeAll() => _api.removeAll();
}
