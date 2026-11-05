import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';

/// For the providers that read the local database once (not a stream): rebuilt when the app moves remote assets to or
/// from where they show, so that what they list follows the trash, the archive and the locked folder
extension RebuildOnAssetChanges on Ref {
  void rebuildOnAssetChanges() {
    final subscription = EventStream.shared.listen<RemoteAssetsChangedEvent>((event) {
      if (event.changesWhereShown) {
        invalidateSelf();
      }
    });
    onDispose(() => unawaited(subscription.cancel()));
  }
}
