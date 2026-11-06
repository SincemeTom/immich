import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/tag.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/presentation/pages/search/paginated_search.provider.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/routing/router.dart';

/// The asset's tags, as the web shows them: when tags are turned on, and to the asset's owner, whose tags they are
class TagsDetails extends ConsumerWidget {
  final BaseAsset asset;

  const TagsDetails({super.key, required this.asset});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tagsEnabled = ref.watch(
      Store.userMetadata.preferences().select((value) => value.valueOrNull?.tagsEnabled ?? false),
    );
    final userId = ref.watch(currentUserProvider)?.id;
    final assetId = switch (asset) {
      RemoteAsset(:final id, :final ownerId) => ownerId == userId ? id : null,
      // backed up from this device, so the current user's
      LocalAsset(:final remoteAssetId) => remoteAssetId,
    };

    if (!tagsEnabled || assetId == null) {
      return const SizedBox.shrink();
    }

    return ref
        .watch(Store.tags.forAsset(assetId))
        .when(
          data: (tags) {
            if (tags.isEmpty) {
              return const SizedBox.shrink();
            }

            return Padding(
              padding: const EdgeInsets.only(left: 16, right: 16, top: 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 12,
                children: [
                  Text(
                    context.t.tags,
                    style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                  ),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final tag in tags)
                        ActionChip(
                          avatar: const Icon(Icons.sell_outlined, size: 16),
                          label: Text(tag.value),
                          onPressed: () => _search(context, ref, tag),
                        ),
                    ],
                  ),
                ],
              ),
            );
          },
          loading: () => const SizedBox.shrink(),
          error: (_, _) => const SizedBox.shrink(),
        );
  }

  /// The search page, showing everything with [tag]
  void _search(BuildContext context, WidgetRef ref, Tag tag) {
    ref.invalidate(assetViewerProvider);
    ref.invalidate(paginatedSearchProvider);

    ref.read(searchPreFilterProvider.notifier)
      ..clear()
      ..setFilter(
        SearchFilter(
          tagIds: [tag.id],
          people: {},
          location: const .new(),
          camera: const .new(),
          date: const .new(),
          display: const .new(isNotInAlbum: false, isArchive: false, isFavorite: false),
          rating: const .new(),
          mediaType: .other,
        ),
      );

    unawaited(context.navigateTo(const SearchRoute()));
  }
}
