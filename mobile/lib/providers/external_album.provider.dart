import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/external_album.dart';
import 'package:immich_mobile/domain/models/external_album.model.dart';

/// The user's external albums account as the server has it; null when the server has no external albums
final externalAlbumAccountProvider = FutureProvider.autoDispose<ExternalAlbumAccount?>(
  (ref) => ref.watch(externalAlbumApiRepositoryProvider).getAccount(),
);

/// What the last sync of the external albums did not match, read when it is looked at
final externalAlbumUnmatchedProvider = FutureProvider.autoDispose<List<ExternalAlbumUnmatched>>(
  (ref) => ref.watch(externalAlbumApiRepositoryProvider).unmatched(),
);
