import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/models/search_result.model.dart';
import 'package:immich_mobile/domain/services/search.service.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/models/search/search_filter.model.dart';
import 'package:immich_mobile/presentation/pages/search/paginated_search.provider.dart';
import 'package:mocktail/mocktail.dart';

class _MockSearchService extends Mock implements SearchService {}

RemoteAsset _asset(String id, {bool isFavorite = false}) => RemoteAsset(
  id: id,
  name: '$id.jpg',
  ownerId: 'owner',
  checksum: 'checksum-$id',
  type: AssetType.image,
  createdAt: DateTime(2025),
  updatedAt: DateTime(2025),
  isFavorite: isFavorite,
  isEdited: false,
);

SearchFilter _filter({bool isArchive = false, bool isFavorite = false}) => SearchFilter(
  people: {},
  location: const SearchLocationFilter(),
  camera: const SearchCameraFilter(),
  date: const SearchDateFilter(),
  display: SearchDisplayFilters(isNotInAlbum: false, isArchive: isArchive, isFavorite: isFavorite),
  rating: const SearchRatingFilter(),
  mediaType: AssetType.other,
);

void main() {
  late _MockSearchService searchService;
  late PaginatedSearchNotifier notifier;

  List<String> shown() => notifier.state.assets.map((asset) => (asset as RemoteAsset).id).toList();

  Future<void> emit(RemoteAssetsChangedEvent event) async {
    EventStream.shared.emit(event);
    await Future<void>.delayed(Duration.zero);
  }

  setUpAll(() => registerFallbackValue(_filter()));

  Future<void> searchWith(List<RemoteAsset> assets, {SearchFilter? filter}) async {
    searchService = _MockSearchService();
    when(() => searchService.search(any(), any())).thenAnswer((_) async => SearchResult(assets: assets));
    notifier = PaginatedSearchNotifier(searchService);
    await notifier.search(filter ?? _filter());
  }

  tearDown(() => notifier.dispose());

  test('trashed results go, and come back in place when restored', () async {
    await searchWith([_asset('a'), _asset('b'), _asset('c')]);
    final counts = <int>[];
    final subscription = notifier.assetCount.listen(counts.add);

    await emit(const RemoteAssetsChangedEvent(['b'], trashed: true));
    expect(shown(), ['a', 'c']);

    await emit(const RemoteAssetsChangedEvent(['b'], restored: true));
    expect(shown(), ['a', 'b', 'c']);
    expect(counts, [2, 3]);
    await subscription.cancel();
  });

  test('archived results leave a timeline search and return when unarchived', () async {
    await searchWith([_asset('a'), _asset('b')]);

    await emit(const RemoteAssetsChangedEvent(['a'], visibility: AssetVisibility.archive));
    expect(shown(), ['b']);

    await emit(const RemoteAssetsChangedEvent(['a'], visibility: AssetVisibility.timeline));
    expect(shown(), ['a', 'b']);
  });

  test('unarchived results leave an archive search', () async {
    await searchWith([
      _asset('a').copyWith(visibility: AssetVisibility.archive),
      _asset('b').copyWith(visibility: AssetVisibility.archive),
    ], filter: _filter(isArchive: true));

    await emit(const RemoteAssetsChangedEvent(['b'], visibility: AssetVisibility.timeline));
    expect(shown(), ['a']);
  });

  test('favorites are updated in place, and leave a favorites search when unfavorited', () async {
    await searchWith([_asset('a'), _asset('b')]);
    await emit(const RemoteAssetsChangedEvent(['a'], isFavorite: true));
    expect(shown(), ['a', 'b']);
    expect((notifier.state.assets.first as RemoteAsset).isFavorite, isTrue);
    notifier.dispose();

    await searchWith([_asset('a', isFavorite: true), _asset('b', isFavorite: true)], filter: _filter(isFavorite: true));
    await emit(const RemoteAssetsChangedEvent(['a'], isFavorite: false));
    expect(shown(), ['b']);
  });

  test('other assets do not touch the results', () async {
    await searchWith([_asset('a')]);
    final counts = <int>[];
    final subscription = notifier.assetCount.listen(counts.add);

    await emit(const RemoteAssetsChangedEvent(['z'], trashed: true));
    expect(shown(), ['a']);
    expect(counts, isEmpty);
    await subscription.cancel();
  });
}
