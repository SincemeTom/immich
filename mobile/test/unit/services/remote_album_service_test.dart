import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/services/remote_album.service.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../mocks.dart';

void main() {
  late RemoteAlbumService sut;
  final mocks = RepositoryMocks();

  setUpAll(() {
    registerFallbackValue(<String>[]);
  });

  setUp(() {
    sut = RemoteAlbumService(mocks.remoteAlbum, mocks.albumApi, MockForegroundUploadService());
  });

  tearDown(() {
    mocks.resetAll();
  });

  group('RemoteAlbumService', () {
    group('removeAssets', () {
      test('persists only the assets the server actually removed, not the whole request', () async {
        const albumId = 'album-1';
        const requested = ['asset-1', 'asset-2', 'asset-3'];
        const removed = ['asset-1', 'asset-3'];

        // The server rejected 'asset-2'
        when(
          () => mocks.albumApi.removeAssets(albumId, requested),
        ).thenAnswer((_) async => (removed: removed, failed: ['asset-2']));
        when(() => mocks.remoteAlbum.removeAssets(albumId, any())).thenAnswer((_) async {});

        final count = await sut.removeAssets(albumId: albumId, assetIds: requested);

        final persisted =
            verify(() => mocks.remoteAlbum.removeAssets(albumId, captureAny())).captured.single as List<String>;
        expect(persisted, removed);
        expect(persisted, isNot(contains('asset-2')));

        expect(count, removed.length);
      });
    });

    group('album assets events', () {
      const albumId = 'album-1';
      late List<AlbumAssetsChangedEvent> events;
      late StreamSubscription<AlbumAssetsChangedEvent> subscription;

      setUp(() {
        events = [];
        subscription = EventStream.shared.listen<AlbumAssetsChangedEvent>(events.add);
      });

      tearDown(() => subscription.cancel());

      test('addAssets tells which assets went in', () async {
        when(
          () => mocks.albumApi.addAssets(albumId, any()),
        ).thenAnswer((_) async => (added: ['asset-1'], failed: ['asset-2']));
        when(() => mocks.remoteAlbum.addAssets(albumId, any())).thenAnswer((_) async => 1);

        await sut.addAssets(albumId: albumId, assetIds: ['asset-1', 'asset-2']);
        await pumpEventQueue();

        expect(events, hasLength(1));
        expect(events.single.albumId, albumId);
        expect(events.single.assetIds, ['asset-1']);
      });

      test('removeAssets tells which assets came out', () async {
        when(
          () => mocks.albumApi.removeAssets(albumId, any()),
        ).thenAnswer((_) async => (removed: ['asset-1'], failed: <String>[]));
        when(() => mocks.remoteAlbum.removeAssets(albumId, any())).thenAnswer((_) async {});

        await sut.removeAssets(albumId: albumId, assetIds: ['asset-1']);
        await pumpEventQueue();

        expect(events.single.assetIds, ['asset-1']);
      });

      test('says nothing when nothing changed', () async {
        when(
          () => mocks.albumApi.addAssets(albumId, any()),
        ).thenAnswer((_) async => (added: <String>[], failed: ['asset-1']));
        when(() => mocks.remoteAlbum.addAssets(albumId, any())).thenAnswer((_) async => 0);
        when(
          () => mocks.albumApi.removeAssets(albumId, any()),
        ).thenAnswer((_) async => (removed: <String>[], failed: ['asset-1']));
        when(() => mocks.remoteAlbum.removeAssets(albumId, any())).thenAnswer((_) async {});

        await sut.addAssets(albumId: albumId, assetIds: ['asset-1']);
        await sut.removeAssets(albumId: albumId, assetIds: ['asset-1']);
        await pumpEventQueue();

        expect(events, isEmpty);
      });
    });
  });
}
