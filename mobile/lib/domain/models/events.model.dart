import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';

// Timeline Events
class TimelineReloadEvent extends Event {
  const TimelineReloadEvent();
}

class ScrollToTopEvent extends Event {
  const ScrollToTopEvent();
}

class ScrollToDateEvent extends Event {
  final DateTime date;

  const ScrollToDateEvent(this.date);
}

// Asset Viewer Events
class ViewerShowDetailsEvent extends Event {
  const ViewerShowDetailsEvent();
}

// Multi-Select Events
class MultiSelectToggleEvent extends Event {
  final bool isEnabled;
  const MultiSelectToggleEvent(this.isEnabled);
}

// Map Events
class MapMarkerReloadEvent extends Event {
  const MapMarkerReloadEvent();
}

// Remote Asset Events
/// The app changed these remote assets on the server, for the lists the local database does not drive (search
/// results): [trashed] (or deleted) and [restored] from the trash, or given a new [visibility] or [isFavorite]
class RemoteAssetsChangedEvent extends Event {
  final List<String> ids;
  final bool trashed;
  final bool restored;
  final AssetVisibility? visibility;
  final bool? isFavorite;

  const RemoteAssetsChangedEvent(
    this.ids, {
    this.trashed = false,
    this.restored = false,
    this.visibility,
    this.isFavorite,
  });

  /// The assets went from, or came back to, where they show: the trash, the archive, the locked folder
  bool get changesWhereShown => trashed || restored || visibility != null;
}

// Remote Album Events
/// The app added or removed [assetIds] to or from the album [albumId], for what shows albums from a one-off read of the
/// local database (the album list's counts, the albums an asset is in)
class AlbumAssetsChangedEvent extends Event {
  final String albumId;
  final List<String> assetIds;

  const AlbumAssetsChangedEvent(this.albumId, this.assetIds);
}
