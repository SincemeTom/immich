import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/domain/models/inferred_location.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/datetime_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail.widget.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset_viewer/asset.provider.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:immich_mobile/utils/timezone.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart' show AssetMediaSize;

final _log = Logger('InferredLocationDetails');

/// Tells that the location of the asset was inferred from the photos taken around it, from which one, and lets its
/// owner clear it. Nothing when it is not inferred (always so on an official server)
class InferredLocationDetails extends ConsumerWidget {
  final RemoteAsset asset;
  final ExifInfo exifInfo;
  final bool isOwner;

  const InferredLocationDetails({super.key, required this.asset, required this.exifInfo, required this.isOwner});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inferred = ref
        .watch(
          inferredLocationProvider((assetId: asset.id, latitude: exifInfo.latitude, longitude: exifInfo.longitude)),
        )
        .valueOrNull;
    if (inferred == null) {
      return const SizedBox.shrink();
    }

    final source = inferred.source;
    final sourceAssetId = source?.assetId;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        children: [
          if (sourceAssetId != null)
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: GestureDetector(
                onTap: () => _showSource(context, sourceAssetId, _sourceText(context, source!)),
                child: ClipRRect(
                  borderRadius: const BorderRadius.all(Radius.circular(8)),
                  child: SizedBox.square(
                    dimension: 44,
                    child: Thumbnail.remote(remoteId: sourceAssetId, thumbhash: ''),
                  ),
                ),
              ),
            ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Tooltip(
                  message: context.t.location_inferred_description,
                  triggerMode: TooltipTriggerMode.tap,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: context.colorScheme.secondaryContainer,
                      borderRadius: const BorderRadius.all(Radius.circular(6)),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      child: Text(
                        context.t.location_inferred,
                        style: context.textTheme.labelSmall?.copyWith(color: context.colorScheme.onSecondaryContainer),
                      ),
                    ),
                  ),
                ),
                if (source != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      _sourceText(context, source),
                      style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                    ),
                  ),
              ],
            ),
          ),
          if (isOwner)
            IconButton(
              icon: const Icon(Icons.close, size: 20),
              tooltip: context.t.location_inferred_clear,
              onPressed: () => _clear(context, ref),
            ),
        ],
      ),
    );
  }

  String _sourceText(BuildContext context, InferredLocationSource source) {
    final taken = source.takenAt;
    final (takenHere, _) = resolveAssetDateTime(asset, exifInfo);
    final sameDay = taken.year == takenHere.year && taken.month == takenHere.month && taken.day == takenHere.day;
    final hour = taken.formatTime(alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context));
    final time = sameDay ? hour : '${DateFormat.MMMd(resolvedDateTimeLocale()).format(taken)} $hour';
    return source.ownerId == asset.ownerId
        ? context.t.location_inferred_from(time: time)
        : context.t.location_inferred_from_user(name: source.ownerName, time: time);
  }

  Future<void> _showSource(BuildContext context, String sourceAssetId, String caption) {
    return showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        clipBehavior: Clip.antiAlias,
        child: GestureDetector(
          onTap: () => Navigator.of(context).pop(),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Image(
                  image: RemoteImageProvider(
                    url: getThumbnailUrlForRemoteId(sourceAssetId, type: AssetMediaSize.preview),
                  ),
                  fit: BoxFit.contain,
                  errorBuilder: (_, _, _) => const SizedBox.square(dimension: 200, child: Icon(Icons.broken_image)),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(caption, textAlign: TextAlign.center),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _clear(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(
        title: context.t.location_inferred_clear,
        content: context.t.location_inferred_clear_prompt,
        ok: context.t.confirm,
      ),
    );
    if (confirmed != true || !context.mounted) {
      return;
    }

    try {
      await ref.read(assetServiceProvider).clearInferredLocation(asset.id);
    } catch (error, stack) {
      _log.severe('Cannot clear the inferred location of ${asset.id}', error, stack);
      if (context.mounted) {
        ImmichToast.show(context: context, msg: context.t.errors.unable_to_change_location, toastType: ToastType.error);
      }
    }
  }
}
