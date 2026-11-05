import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';

class StackChildrenNotifier extends AutoDisposeFamilyAsyncNotifier<List<RemoteAsset>, BaseAsset> {
  @override
  Future<List<RemoteAsset>> build(BaseAsset asset) {
    if (asset is! RemoteAsset || asset.stackId == null) {
      return Future.value(const []);
    }

    return ref.watch(assetServiceProvider).getStack(asset);
  }
}

final stackChildrenNotifier = AsyncNotifierProvider.autoDispose
    .family<StackChildrenNotifier, List<RemoteAsset>, BaseAsset>(StackChildrenNotifier.new);

/// A stack, its cover and what is in it, as they change
final stackProvider = StreamProvider.autoDispose.family<StackResponse?, String>(
  (ref, stackId) => ref.watch(assetServiceProvider).watchStack(stackId),
);
