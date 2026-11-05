import 'package:collection/collection.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/person.dart';
import 'package:immich_mobile/data/store/user_metadata.dart';
import 'package:immich_mobile/data/store/util/cache.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';

/// People representing collections of faces and assets
///
/// State is stored in the local DB, while mutations are pushed to both HTTP and DB
extension type const PersonStore._(Provider<PersonMutations> _provider) implements Provider<PersonMutations> {
  /// Internal: access through `Store.people`
  static final PersonStore instance = PersonStore._(Provider((ref) => PersonMutations._(ref)));

  /// Get the person specified by [personId]
  ///
  /// **NOTE:** This is only reactive to the local DB
  AutoDisposeStreamProvider<Person?> byId(String personId) => _byIdProvider(personId);

  /// Get the people present in the asset [assetId]
  ///
  /// **NOTE:** This is only reactive to the local DB
  AutoDisposeStreamProvider<List<Person>> forAsset(String assetId) => _forAssetProvider(assetId);

  /// Get all known people, honoring the user's minimum detected face count preference; the hidden ones too (last)
  /// with [includeHidden]
  ///
  /// **NOTE:** This only hits the local DB
  AutoDisposeStreamProvider<List<Person>> all({bool includeHidden = false}) => _allProvider(includeHidden);
}

final _peopleDb = driftProvider.select((db) => db.peopleDatabaseRepository);

final _byIdProvider = StreamProvider.autoDispose.family<Person?, String>(
  (ref, personId) => ref.watch(_peopleDb).watchPerson(personId).distinct(),
);

final _forAssetProvider = StreamProvider.autoDispose.family<List<Person>, String>(
  (ref, assetId) => ref.watch(_peopleDb).watchPeopleForAsset(assetId).distinct(const ListEquality<Person>().equals),
);

final _allProvider = StreamProvider.autoDispose.family<List<Person>, bool>((ref, includeHidden) async* {
  final prefs = await ref.watch(UserMetadataStore.instance.preferences().future);

  yield* ref
      .watch(_peopleDb)
      .watchAll(minFaces: prefs?.minimumFaces ?? 3, includeHidden: includeHidden)
      .distinct(const ListEquality<Person>().equals);
});

class PersonMutations extends StoreMutations {
  const PersonMutations._(super.ref);

  /// Update a person's name
  Future<int> updateName(String personId, String name) async {
    await read(personApiRepositoryProvider).update(personId, name: name);
    return read(_peopleDb).updateName(personId, name);
  }

  /// Update a person's birthday
  Future<int> updateBirthday(String personId, DateTime birthday) async {
    await read(personApiRepositoryProvider).update(personId, birthday: birthday);
    return read(_peopleDb).updateBirthday(personId, birthday);
  }

  /// Hide a person from the people lists (and their faces from the photos'), or show them again
  Future<int> setHidden(String personId, bool isHidden) async {
    await read(personApiRepositoryProvider).update(personId, isHidden: isHidden);
    return read(_peopleDb).updateHidden(personId, isHidden);
  }

  /// Cut the person's thumbnail from their face on [assetId]
  Future<int> setFeaturePhoto(String personId, String assetId) async {
    final person = await read(personApiRepositoryProvider).update(personId, featureFaceAssetId: assetId);
    return read(_peopleDb).updateFeatureFace(personId, assetId, updatedAt: person.updatedAt);
  }

  /// Merge [sourceIds] into [targetId]; the ids of those merged
  Future<List<String>> merge(String targetId, List<String> sourceIds) async {
    final merged = await read(personApiRepositoryProvider).merge(targetId, sourceIds);
    if (merged.isNotEmpty) {
      await read(_peopleDb).merge(targetId, merged);
    }
    return merged;
  }

  /// [personId]'s faces on [assetId] are [newPersonId]'s, or a new person's if null; that person
  Future<Person> reassignFaces(String assetId, String personId, {String? newPersonId}) async {
    final api = read(personApiRepositoryProvider);
    final db = read(_peopleDb);
    final faceIds = await db.getFaceIds(assetId, personId);

    Person? target;
    if (newPersonId == null) {
      target = await api.create();
      final ownerId = await db.getOwnerId(personId);
      if (ownerId != null) {
        await db.insert(target, ownerId: ownerId);
      }
    }
    final targetId = newPersonId ?? target!.id;

    for (final faceId in faceIds) {
      await api.reassignFace(faceId, targetId);
    }
    await db.reassignFaces(faceIds, targetId);
    if (target != null) {
      // a new person's thumbnail is the face just given
      await db.updateFeatureFace(targetId, assetId);
    }
    return target ?? (await db.watchPerson(targetId).first) ?? Person(id: targetId, name: '');
  }

  /// [personId]'s faces on [assetId] are no faces
  Future<void> removeFaces(String assetId, String personId) async {
    final api = read(personApiRepositoryProvider);
    final db = read(_peopleDb);
    final faceIds = await db.getFaceIds(assetId, personId);
    for (final faceId in faceIds) {
      await api.deleteFace(faceId);
    }
    await db.deleteFaces(faceIds);
  }
}
