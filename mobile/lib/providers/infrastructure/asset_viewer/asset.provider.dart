import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/domain/models/inferred_location.model.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';

final assetExifProvider = StreamProvider.autoDispose.family<ExifInfo?, BaseAsset>((ref, asset) {
  return ref.watch(assetServiceProvider).watchExif(asset);
});

/// Whether the location of a remote asset was inferred, and from what. Asked again when the location changes
final inferredLocationProvider = FutureProvider.autoDispose
    .family<InferredLocation?, ({String assetId, double? latitude, double? longitude})>((ref, key) {
      if (key.latitude == null || key.longitude == null) {
        return null;
      }
      return ref.watch(assetServiceProvider).getInferredLocation(key.assetId);
    });
