import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/timeline/multiselect.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';

/// Pick one of [person]'s photos for their cover, as the web's "Select cover photo"; its server id, or null
Future<String?> pickPersonCover(BuildContext context, Person person) {
  return Navigator.of(
    context,
  ).push<String>(MaterialPageRoute(fullscreenDialog: true, builder: (_) => PersonCoverPickerPage(person: person)));
}

/// [person]'s timeline, of the user's own photos (their faces are on these), where a tap picks the cover
class PersonCoverPickerPage extends ConsumerWidget {
  final Person person;

  const PersonCoverPickerPage({super.key, required this.person});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ProviderScope(
      overrides: [
        multiSelectProvider.overrideWith(
          () => MultiSelectNotifier(
            const MultiSelectState(selectedAssets: {}, lockedSelectionAssets: {}, forceEnable: true),
          ),
        ),
        timelineServiceProvider.overrideWith((ref) {
          final user = ref.watch(currentUserProvider);
          if (user == null) {
            throw Exception('User must be logged in to pick a person cover');
          }

          final timelineService = ref.watch(timelineFactoryProvider).person([user.id], person.id);
          ref.onDispose(timelineService.dispose);
          return timelineService;
        }),
      ],
      child: const Timeline(bottomSheet: null, selectionAppBar: PersonCoverPickerAppBar()),
    );
  }
}

@visibleForTesting
class PersonCoverPickerAppBar extends ConsumerWidget {
  const PersonCoverPickerAppBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // one photo only: picking another replaces it
    ref.listen(multiSelectProvider.select((s) => s.selectedAssets), (previous, next) {
      if (next.length > 1) {
        final notifier = ref.read(multiSelectProvider.notifier);
        for (final asset in previous ?? const <BaseAsset>{}) {
          notifier.deselectAsset(asset);
        }
      }
    });

    final selected = ref.watch(multiSelectProvider.select((s) => s.selectedAssets));
    final remoteId = selected.length == 1 ? selected.first.remoteId : null;

    return SliverAppBar(
      floating: true,
      pinned: true,
      snap: false,
      backgroundColor: context.colorScheme.surfaceContainer,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(5))),
      automaticallyImplyLeading: false,
      leading: IconButton(
        icon: const Icon(Icons.close_rounded),
        tooltip: context.t.cancel,
        onPressed: () => Navigator.of(context).pop(),
      ),
      centerTitle: true,
      title: Text(context.t.select_featured_photo),
      actions: [
        TextButton(
          key: const Key('person-cover-done'),
          onPressed: remoteId == null ? null : () => Navigator.of(context).pop(remoteId),
          child: Text(
            context.t.done,
            style: context.textTheme.titleSmall?.copyWith(
              color: remoteId == null
                  ? context.colorScheme.onSurface.withValues(alpha: 0.38)
                  : context.colorScheme.primary,
            ),
          ),
        ),
      ],
    );
  }
}
