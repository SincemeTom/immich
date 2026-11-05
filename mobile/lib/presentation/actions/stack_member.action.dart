import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_stack.provider.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';

typedef _State = ({String assetId, StackResponse stack});

/// The one asset of the user's own shown, with the stack it is in
final _stateProvider = Provider.family.autoDispose<_State?, ActionSource>((ref, source) {
  final asset = ref.watch(ownedAssetsActionProvider(source)).singleOrNull;
  final stackId = asset?.stackId;
  if (asset == null || stackId == null) {
    return null;
  }

  final stack = ref.watch(stackProvider(stackId)).valueOrNull;
  if (stack == null || !stack.assetIds.contains(asset.id)) {
    return null;
  }
  return (assetId: asset.id, stack: stack);
}, dependencies: [ownedAssetsActionProvider]);

/// Makes the asset shown the cover of its stack
class SetStackCoverAction extends AssetActionBuilder {
  const SetStackCoverAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final state = ref.watch(_stateProvider(source));
    if (state == null || state.stack.primaryAssetId == state.assetId) {
      return null;
    }

    return .new(
      icon: Icons.photo_filter_outlined,
      label: context.t.set_stack_primary_asset,
      onAction: () => _setCover(context, ref, state),
    );
  }

  Future<void> _setCover(BuildContext context, WidgetRef ref, _State state) async {
    final message = context.t.stack_cover_updated;
    final toastService = ref.read(toastServiceProvider);

    try {
      await ref.read(assetServiceProvider).setStackPrimary(state.stack.id, state.assetId);
      // the cover comes first in the stack now
      ref.invalidate(stackChildrenNotifier);
      ref.read(assetViewerProvider.notifier).setStackIndex(0);
      toastService.success(message);
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to set the cover of the stack");
    }
  }
}

/// Takes the asset shown out of its stack; not the cover, and not from a stack of two, which would no longer be one
class RemoveFromStackAction extends AssetActionBuilder {
  const RemoveFromStackAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final state = ref.watch(_stateProvider(source));
    if (state == null || state.stack.primaryAssetId == state.assetId || state.stack.assetIds.length <= 2) {
      return null;
    }

    return .new(
      icon: Icons.layers_clear_outlined,
      label: context.t.viewer_remove_from_stack,
      onAction: () => _remove(context, ref, state),
    );
  }

  Future<void> _remove(BuildContext context, WidgetRef ref, _State state) async {
    final message = context.t.removed_from_stack;
    final toastService = ref.read(toastServiceProvider);

    try {
      await ref.read(assetServiceProvider).removeFromStack(state.stack.id, state.assetId);
      ref.invalidate(stackChildrenNotifier);
      toastService.success(message);
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to remove the asset from the stack");
    }
  }
}

/// Keeps the asset shown and moves the rest of its stack to the trash
class KeepThisDeleteOthersAction extends AssetActionBuilder {
  const KeepThisDeleteOthersAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final state = ref.watch(_stateProvider(source));
    if (state == null) {
      return null;
    }

    return .new(
      icon: Icons.push_pin_outlined,
      label: context.t.keep_this_delete_others,
      onAction: () => _keep(context, ref, state),
    );
  }

  Future<void> _keep(BuildContext context, WidgetRef ref, _State state) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(
        title: context.t.keep_this_delete_others,
        content: context.t.confirm_keep_this_delete_others,
        ok: context.t.delete_others,
      ),
    );
    if (confirmed != true || !context.mounted) {
      return;
    }

    final count = state.stack.assetIds.length - 1;
    final message = context.t.kept_this_deleted_others(count: count);
    final assetService = ref.read(assetServiceProvider);
    final toastService = ref.read(toastServiceProvider);

    try {
      await assetService.keepOnlyInStack(state.stack, state.assetId);
      ref.invalidate(stackChildrenNotifier);
      toastService.success(message);
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to keep this and delete the others");
    }
  }
}
