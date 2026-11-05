import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/person.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../medium/repository_context.dart';

class _MockPersonApi extends Mock implements PersonApiRepository {}

void main() {
  late MediumRepositoryContext ctx;
  late _MockPersonApi api;
  late ProviderContainer container;

  setUp(() {
    ctx = MediumRepositoryContext();
    api = _MockPersonApi();
    container = ProviderContainer(
      overrides: [
        driftProvider.overrideWithValue(ctx.db),
        personApiRepositoryProvider.overrideWithValue(api),
        // No stored preferences: the default minimum face count applies
        Store.userMetadata.preferences().overrideWith((ref) => Stream.value(null)),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(ctx.dispose);
  });

  Future<Person?> byId(String personId) => container.read(Store.people.byId(personId).future);

  test('forAsset serves the people on the asset', () async {
    final user = await ctx.newUser();
    final asset = await ctx.newRemoteAsset(ownerId: user.id);
    final person = await ctx.newPerson(ownerId: user.id);
    await ctx.newFace(assetId: asset.id, personId: person.id);

    final people = await container.read(Store.people.forAsset(asset.id).future);

    expect(people.map((p) => p.id), [person.id]);
  });

  test('all serves named people, hiding unnamed ones lacking the face count', () async {
    final user = await ctx.newUser();
    final asset = await ctx.newRemoteAsset(ownerId: user.id);
    final named = await ctx.newPerson(ownerId: user.id, name: 'Alice');
    final unnamed = await ctx.newPerson(ownerId: user.id, name: '');

    await ctx.newFace(assetId: asset.id, personId: named.id);
    await ctx.newFace(assetId: asset.id, personId: unnamed.id);

    final people = await container.read(Store.people.all().future);

    expect(people.map((p) => p.id), [named.id]);
  });

  test('forAsset re-emits when a person is renamed', () async {
    final user = await ctx.newUser();
    final asset = await ctx.newRemoteAsset(ownerId: user.id);
    final person = await ctx.newPerson(ownerId: user.id, name: 'Old');
    await ctx.newFace(assetId: asset.id, personId: person.id);

    when(() => api.update(person.id, name: 'New')).thenAnswer((_) async => Person(id: person.id, name: 'New'));

    final renamed = Completer<void>();

    final provider = Store.people.forAsset(asset.id);
    container.listen(provider, (_, next) {
      if (next.valueOrNull?.single.name == 'New' && !renamed.isCompleted) {
        renamed.complete();
      }
    });
    await container.read(provider.future);

    await container.read(Store.people).updateName(person.id, 'New');

    await expectLater(renamed.future, completes);
  });

  test('forAsset does not push updates unnecessarily', () async {
    final user = await ctx.newUser();
    final asset = await ctx.newRemoteAsset(ownerId: user.id);
    final person = await ctx.newPerson(ownerId: user.id, name: 'Old');
    await ctx.newFace(assetId: asset.id, personId: person.id);

    var emissions = 0;

    final provider = Store.people.forAsset(asset.id);
    container.listen(provider, (_, _) => emissions += 1);
    await container.read(provider.future);

    await ctx.newPerson(ownerId: user.id, name: 'Unrelated');

    await pumpEventQueue();
    // Only should have received the first, loaded event
    expect(emissions, 1);
  });

  test('updateName pushes to the server, then saves locally', () async {
    final user = await ctx.newUser();
    final person = await ctx.newPerson(ownerId: user.id, name: 'Old');

    when(() => api.update(person.id, name: 'New')).thenAnswer((_) async => Person(id: person.id, name: 'New'));

    await container.read(Store.people).updateName(person.id, 'New');

    verify(() => api.update(person.id, name: 'New')).called(1);
    expect((await byId(person.id))?.name, 'New');
  });

  test('updateName leaves the DB untouched when the server rejects', () async {
    final user = await ctx.newUser();
    final person = await ctx.newPerson(ownerId: user.id, name: 'Old');
    when(() => api.update(person.id, name: 'New')).thenThrow(Exception('rejected'));

    await expectLater(container.read(Store.people).updateName(person.id, 'New'), throwsException);

    expect((await byId(person.id))?.name, 'Old');
  });

  test('updateBirthday pushes to the server, then saves locally', () async {
    final user = await ctx.newUser();
    final person = await ctx.newPerson(ownerId: user.id);
    final birthday = DateTime.utc(1990, 4, 2);

    when(
      () => api.update(person.id, birthday: birthday),
    ).thenAnswer((_) async => Person(id: person.id, name: person.name, birthDate: birthday));

    await container.read(Store.people).updateBirthday(person.id, birthday);

    verify(() => api.update(person.id, birthday: birthday)).called(1);
    expect((await byId(person.id))?.birthDate, birthday);
  });

  group('Pixcellar', () {
    Future<List<String>> allIds({bool includeHidden = false}) async =>
        (await container.read(Store.people.all(includeHidden: includeHidden).future)).map((p) => p.id).toList();

    test('setHidden takes a person out of the list, and all(includeHidden) shows them last', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);
      final alice = await ctx.newPerson(ownerId: user.id, name: 'Alice');
      final bob = await ctx.newPerson(ownerId: user.id, name: 'Bob');
      await ctx.newFace(assetId: asset.id, personId: alice.id);
      await ctx.newFace(assetId: asset.id, personId: bob.id);
      when(
        () => api.update(alice.id, isHidden: true),
      ).thenAnswer((_) async => Person(id: alice.id, name: 'Alice', isHidden: true));

      await container.read(Store.people).setHidden(alice.id, true);

      expect(await allIds(), [bob.id]);
      expect(await allIds(includeHidden: true), [bob.id, alice.id]);
      expect((await byId(alice.id))?.isHidden, isTrue);
    });

    test('merge moves the faces, removes the merged people and keeps the first name', () async {
      final user = await ctx.newUser();
      final asset1 = await ctx.newRemoteAsset(ownerId: user.id);
      final asset2 = await ctx.newRemoteAsset(ownerId: user.id);
      final target = await ctx.newPerson(ownerId: user.id, name: '');
      final source = await ctx.newPerson(ownerId: user.id, name: 'Carol');
      final refused = await ctx.newPerson(ownerId: user.id, name: 'Dan');
      await ctx.newFace(assetId: asset1.id, personId: target.id);
      await ctx.newFace(assetId: asset2.id, personId: source.id);
      await ctx.newFace(assetId: asset2.id, personId: refused.id);
      when(() => api.merge(target.id, [source.id, refused.id])).thenAnswer((_) async => [source.id]);

      final merged = await container.read(Store.people).merge(target.id, [source.id, refused.id]);

      expect(merged, [source.id]);
      expect(await byId(source.id), isNull);
      expect((await byId(target.id))?.name, 'Carol');
      expect(
        (await container.read(Store.people.forAsset(asset2.id).future)).map((p) => p.id),
        unorderedEquals([target.id, refused.id]),
      );
    });

    test('reassignFaces to someone else, then to a new person', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);
      final wrong = await ctx.newPerson(ownerId: user.id, name: 'Wrong');
      final right = await ctx.newPerson(ownerId: user.id, name: 'Right');
      final face = await ctx.newFace(assetId: asset.id, personId: wrong.id);
      when(() => api.reassignFace(face.id, any())).thenAnswer((_) async {});
      when(() => api.create()).thenAnswer((_) async => const Person(id: 'new-person', name: ''));

      await container.read(Store.people).reassignFaces(asset.id, wrong.id, newPersonId: right.id);
      expect((await container.read(Store.people.forAsset(asset.id).future)).map((p) => p.id), [right.id]);
      verify(() => api.reassignFace(face.id, right.id)).called(1);

      final created = await container.read(Store.people).reassignFaces(asset.id, right.id);
      expect(created.id, 'new-person');
      verify(() => api.reassignFace(face.id, 'new-person')).called(1);
    });

    test('removeFaces takes the person off the photo', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);
      final person = await ctx.newPerson(ownerId: user.id, name: 'Eve');
      final face = await ctx.newFace(assetId: asset.id, personId: person.id);
      when(() => api.deleteFace(face.id)).thenAnswer((_) async {});

      await container.read(Store.people).removeFaces(asset.id, person.id);

      verify(() => api.deleteFace(face.id)).called(1);
      expect(await container.read(Store.people.forAsset(asset.id).future), isEmpty);
    });
  });
}
