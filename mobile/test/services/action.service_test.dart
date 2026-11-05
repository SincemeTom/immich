import 'dart:async';

import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/services/action.service.dart';
import 'package:mocktail/mocktail.dart';

import '../infrastructure/repository.mock.dart';
import '../repository.mocks.dart';

void main() {
  late ActionService sut;

  late MockAssetApiRepository assetApiRepository;
  late MockRemoteAssetRepository remoteAssetRepository;

  late Drift db;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
  });

  tearDownAll(() async {
    debugDefaultTargetPlatformOverride = null;
    await Store.clear();
    await db.close();
  });

  setUp(() {
    assetApiRepository = MockAssetApiRepository();
    remoteAssetRepository = MockRemoteAssetRepository();

    sut = ActionService(assetApiRepository, remoteAssetRepository);
  });

  tearDown(() async {
    await Store.clear();
  });

  group('ActionService.updateRating', () {
    const assetId = 'asset_id_1';

    test('calls both repositories with the given rating', () async {
      when(() => assetApiRepository.updateRating(assetId, 3)).thenAnswer((_) async {});
      when(() => remoteAssetRepository.updateRating(assetId, 3)).thenAnswer((_) async {});

      final result = await sut.updateRating(assetId, 3);

      expect(result, isTrue);
      verify(() => assetApiRepository.updateRating(assetId, 3)).called(1);
      verify(() => remoteAssetRepository.updateRating(assetId, 3)).called(1);
    });

    test('calls both repositories with null to clear rating', () async {
      when(() => assetApiRepository.updateRating(assetId, null)).thenAnswer((_) async {});
      when(() => remoteAssetRepository.updateRating(assetId, null)).thenAnswer((_) async {});

      final result = await sut.updateRating(assetId, null);

      expect(result, isTrue);
      verify(() => assetApiRepository.updateRating(assetId, null)).called(1);
      verify(() => remoteAssetRepository.updateRating(assetId, null)).called(1);
    });
  });

  group('ActionService whole trash', () {
    const userId = 'user-1';
    late List<RemoteAssetsChangedEvent> events;
    late StreamSubscription<RemoteAssetsChangedEvent> subscription;

    setUp(() {
      events = [];
      subscription = EventStream.shared.listen<RemoteAssetsChangedEvent>(events.add);
    });

    tearDown(() => subscription.cancel());

    test('emptyTrash tells what it deleted', () async {
      when(() => assetApiRepository.emptyTrash()).thenAnswer((_) async => 2);
      when(() => remoteAssetRepository.emptyTrash(userId)).thenAnswer((_) async => ['a', 'b']);

      expect(await sut.emptyTrash(userId), 2);
      await pumpEventQueue();

      expect(events, hasLength(1));
      expect(events.single.ids, ['a', 'b']);
      expect(events.single.trashed, isTrue);
      expect(events.single.changesWhereShown, isTrue);
    });

    test('restoreAllTrash tells what it restored', () async {
      when(() => assetApiRepository.restoreAllTrash()).thenAnswer((_) async => 1);
      when(() => remoteAssetRepository.restoreAllTrash(userId)).thenAnswer((_) async => ['a']);

      expect(await sut.restoreAllTrash(userId), 1);
      await pumpEventQueue();

      expect(events, hasLength(1));
      expect(events.single.ids, ['a']);
      expect(events.single.restored, isTrue);
    });

    test('says nothing when the trash was already empty', () async {
      when(() => assetApiRepository.emptyTrash()).thenAnswer((_) async => 0);
      when(() => remoteAssetRepository.emptyTrash(userId)).thenAnswer((_) async => []);
      when(() => assetApiRepository.restoreAllTrash()).thenAnswer((_) async => 0);
      when(() => remoteAssetRepository.restoreAllTrash(userId)).thenAnswer((_) async => []);

      await sut.emptyTrash(userId);
      await sut.restoreAllTrash(userId);
      await pumpEventQueue();

      expect(events, isEmpty);
    });
  });
}
