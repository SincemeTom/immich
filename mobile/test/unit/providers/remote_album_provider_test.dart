import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../factories/remote_album_factory.dart';

void main() {
  late MockRemoteAlbumService service;
  late ProviderContainer container;

  final album = RemoteAlbumFactory.create(id: 'album-1', assetCount: 2);
  final other = RemoteAlbumFactory.create(id: 'album-2', assetCount: 5);

  setUp(() {
    service = MockRemoteAlbumService();
    container = ProviderContainer(overrides: [remoteAlbumServiceProvider.overrideWithValue(service)]);
    when(() => service.getAll()).thenAnswer((_) async => [album, other]);
  });

  tearDown(() => container.dispose());

  test('an album the app changed is read again', () async {
    await container.read(remoteAlbumProvider.notifier).refresh();
    when(() => service.get(album.id)).thenAnswer((_) async => album.copyWith(assetCount: 1));

    EventStream.shared.emit(AlbumAssetsChangedEvent(album.id, const ['asset-1']));
    await pumpEventQueue();

    final albums = container.read(remoteAlbumProvider).albums;
    expect(albums.map((a) => a.assetCount), [1, 5]);
    verifyNever(() => service.get(other.id));
  });

  test('the albums are read again once after a burst of trashing and restoring', () async {
    await container.read(remoteAlbumProvider.notifier).refresh();
    clearInteractions(service);
    when(() => service.getAll()).thenAnswer((_) async => [album.copyWith(assetCount: 1), other]);

    EventStream.shared.emit(const RemoteAssetsChangedEvent(['asset-1'], trashed: true));
    EventStream.shared.emit(const RemoteAssetsChangedEvent(['asset-1'], restored: true));
    EventStream.shared.emit(const RemoteAssetsChangedEvent(['asset-2'], trashed: true));
    await Future<void>.delayed(const Duration(milliseconds: 400));

    verify(() => service.getAll()).called(1);
    expect(container.read(remoteAlbumProvider).albums.first.assetCount, 1);
  });

  test('a favorite does not read the albums again', () async {
    await container.read(remoteAlbumProvider.notifier).refresh();
    clearInteractions(service);

    EventStream.shared.emit(const RemoteAssetsChangedEvent(['asset-1'], isFavorite: true));
    await Future<void>.delayed(const Duration(milliseconds: 400));

    verifyNever(() => service.getAll());
  });

  test('nothing is read before the albums were', () async {
    container.read(remoteAlbumProvider);

    EventStream.shared.emit(AlbumAssetsChangedEvent(album.id, const ['asset-1']));
    EventStream.shared.emit(const RemoteAssetsChangedEvent(['asset-1'], trashed: true));
    await Future<void>.delayed(const Duration(milliseconds: 400));

    verifyNever(() => service.getAll());
    verifyNever(() => service.get(any()));
  });
}
