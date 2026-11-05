import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/providers/infrastructure/search.provider.dart';

final searchPreFilterProvider = NotifierProvider<SearchFilterProvider, SearchFilter?>(SearchFilterProvider.new);

class SearchFilterProvider extends Notifier<SearchFilter?> {
  @override
  SearchFilter? build() {
    return null;
  }

  void setFilter(SearchFilter? filter) {
    state = filter;
  }

  void clear() {
    state = null;
  }
}

class SearchState {
  final List<BaseAsset> assets;
  final int? nextPage;
  final bool isLoading;

  const SearchState({this.assets = const [], this.nextPage = 1, this.isLoading = false});
}

final paginatedSearchProvider = StateNotifierProvider<PaginatedSearchNotifier, SearchState>(
  (ref) => PaginatedSearchNotifier(ref.watch(searchServiceProvider)),
);

class PaginatedSearchNotifier extends StateNotifier<SearchState> {
  final SearchService _searchService;
  final _assetCountController = StreamController<int>.broadcast();
  late final StreamSubscription<RemoteAssetsChangedEvent> _changes;

  /// The filter of the results shown
  SearchFilter? _filter;

  /// The results taken out after a change (by id, with where they were), to put back on its undo
  final Map<String, (int, BaseAsset)> _removed = {};

  PaginatedSearchNotifier(this._searchService) : super(const SearchState()) {
    _changes = EventStream.shared.listen<RemoteAssetsChangedEvent>(_onAssetsChanged);
  }

  Stream<int> get assetCount => _assetCountController.stream;

  Future<void> search(SearchFilter filter) async {
    if (state.nextPage == null || state.isLoading) {
      return;
    }

    _filter = filter;
    state = SearchState(assets: state.assets, nextPage: state.nextPage, isLoading: true);

    final result = await _searchService.search(filter, state.nextPage!);

    if (result == null) {
      state = SearchState(assets: state.assets, nextPage: state.nextPage);
      return;
    }

    final assets = [...state.assets, ...result.assets];
    state = SearchState(assets: assets, nextPage: result.nextPage);

    _assetCountController.add(assets.length);
  }

  void clear() {
    _filter = null;
    _removed.clear();
    state = const SearchState();
    _assetCountController.add(0);
  }

  /// Keeps the results in step with what the app did to them: trashed ones and those that no longer match the
  /// filter (archived, locked, unarchived, unfavorited) go, and come back on undo; the others are updated in place
  void _onAssetsChanged(RemoteAssetsChangedEvent event) {
    final filter = _filter;
    if (filter == null || (state.assets.isEmpty && _removed.isEmpty)) {
      return;
    }

    final ids = event.ids.toSet();
    final shownVisibility = filter.display.isArchive ? AssetVisibility.archive : AssetVisibility.timeline;
    bool matches(RemoteAsset asset) =>
        asset.visibility == shownVisibility && (!filter.display.isFavorite || asset.isFavorite);

    RemoteAsset changed(RemoteAsset asset) =>
        asset.copyWith(visibility: event.visibility, isFavorite: event.isFavorite);

    final assets = <BaseAsset>[];
    var touched = false;
    for (final (index, asset) in state.assets.indexed) {
      if (asset is! RemoteAsset || !ids.contains(asset.id)) {
        assets.add(asset);
        continue;
      }
      touched = true;
      final updated = changed(asset);
      if (event.trashed || !matches(updated)) {
        _removed[asset.id] = (index, updated);
      } else {
        assets.add(updated);
      }
    }

    // put back those that match again (restored from the trash, or the change undone)
    final back = [
      for (final id in ids)
        if (_removed[id] case (final index, final RemoteAsset asset)) (index, event.trashed ? asset : changed(asset)),
    ].where((entry) => !event.trashed && matches(entry.$2)).toList()..sort((a, b) => a.$1.compareTo(b.$1));
    for (final (index, asset) in back) {
      _removed.remove(asset.id);
      assets.insert(index.clamp(0, assets.length), asset);
      touched = true;
    }

    if (!touched) {
      return;
    }
    state = SearchState(assets: assets, nextPage: state.nextPage, isLoading: state.isLoading);
    _assetCountController.add(assets.length);
  }

  @override
  void dispose() {
    unawaited(_changes.cancel());
    unawaited(_assetCountController.close());
    super.dispose();
  }
}
