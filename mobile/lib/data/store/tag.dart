import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/tag.dart';
import 'package:immich_mobile/data/store/util/cache.dart';
import 'package:immich_mobile/domain/models/tag.model.dart';
import 'package:logging/logging.dart';

final _log = Logger("TagStore");

/// User defined tags that can be applied to assets
///
/// All operations directly access the HTTP API only
extension type const TagStore._(Provider<TagMutations> _provider) implements Provider<TagMutations> {
  static final TagStore instance = TagStore._(Provider((ref) => TagMutations._(ref)));

  /// Every tag known to the server
  ///
  /// **NOTE:** This is not reactive to changes, and only hits the HTTP API
  AutoDisposeFutureProvider<List<Tag>> all() => _allProvider;

  /// The tags on the asset [assetId], sorted by value. The server lists them to the asset's owner only
  ///
  /// **NOTE:** Not reactive either; invalidate [forAnyAsset] after tags change
  AutoDisposeFutureProvider<List<Tag>> forAsset(String assetId) => _forAssetProvider(assetId);

  /// Every [forAsset] query, to invalidate them all at once
  ProviderOrFamily get forAnyAsset => _forAssetProvider;
}

final _allProvider = FutureProvider.autoDispose<List<Tag>>((ref) async {
  try {
    return await ref.watch(tagApiRepositoryProvider).getAll();
  } catch (error, stack) {
    _log.severe("Failed to get all tags", error, stack);
    return const [];
  }
});

final _forAssetProvider = FutureProvider.autoDispose.family<List<Tag>, String>((ref, assetId) async {
  try {
    final tags = await ref.watch(tagApiRepositoryProvider).getForAsset(assetId);
    return [...tags]..sort((a, b) => a.value.compareTo(b.value));
  } catch (error, stack) {
    _log.severe("Failed to get the tags of asset $assetId", error, stack);
    rethrow;
  }
});

class TagMutations extends StoreMutations {
  const TagMutations._(super.ref);

  /// Create the tags named [values], returning the list of successfully created (or pre-existing) tags
  Future<List<Tag>> upsert(List<String> values) async {
    try {
      return await read(tagApiRepositoryProvider).upsert(values);
    } catch (error, stack) {
      _log.severe("Failed to upsert tags", error, stack);
      rethrow;
    }
  }

  /// Apply every tag in [tagIds] to every asset in [assetIds], returning the number of assets successfully tagged
  Future<int> applyToAssets(List<String> assetIds, List<String> tagIds) async {
    try {
      return await read(tagApiRepositoryProvider).bulkTagAssets(assetIds, tagIds);
    } catch (error, stack) {
      _log.severe("Failed to tag assets", error, stack);
      rethrow;
    }
  }
}
