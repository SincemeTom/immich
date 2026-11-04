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
}
