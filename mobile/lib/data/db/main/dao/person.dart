import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/dao/person.drift.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/people/asset_face.drift.dart';
import 'package:immich_mobile/data/db/main/table/people/person.drift.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';

@DriftAccessor()
class PeopleDatabaseRepository extends DatabaseAccessor<Drift> with $PeopleDatabaseRepositoryMixin {
  PeopleDatabaseRepository(super.attachedDatabase);

  Drift get _db => attachedDatabase;

  /// The person for the given [personId], if any
  Stream<Person?> watchPerson(String personId) {
    final query = _db.select(_db.personEntity)..where((row) => row.id.equals(personId));

    return query.map((row) => row.toDto()).watchSingleOrNull();
  }

  /// The people associated with a given [assetId]
  Stream<List<Person>> watchPeopleForAsset(String assetId) {
    // An asset can have multiple face records for the same person (e.g., metadata
    // imports alongside ML detections). Use a subquery instead of a join so each
    // person is returned once, regardless of how many of their faces are on the asset
    final faceQuery = _db.assetFaceEntity.selectOnly()
      ..addColumns([_db.assetFaceEntity.personId])
      ..where(
        _db.assetFaceEntity.assetId.equals(assetId) &
            _db.assetFaceEntity.isVisible.equals(true) &
            _db.assetFaceEntity.deletedAt.isNull(),
      );

    final query = _db.select(_db.personEntity)
      ..where((row) => row.id.isInQuery(faceQuery) & row.isHidden.equals(false));

    return query.map((row) => row.toDto()).watch();
  }

  /// All known people with a known associated face and asset
  ///
  /// If [minFaces] is provided (defaults to 3), restrict to people having at least that many unique face entries;
  /// the hidden ones come too with [includeHidden], after the others
  Stream<List<Person>> watchAll({int minFaces = 3, bool includeHidden = false}) {
    final people = _db.personEntity;
    final faces = _db.assetFaceEntity;
    final assets = _db.remoteAssetEntity;

    final visible =
        assets.deletedAt.isNull() &
        assets.visibility.equalsValue(AssetVisibility.timeline) &
        faces.isVisible.equals(true) &
        faces.deletedAt.isNull();
    final query =
        _db.select(people).join([
            innerJoin(faces, faces.personId.equalsExp(people.id)),
            innerJoin(assets, assets.id.equalsExp(faces.assetId)),
          ])
          ..where(includeHidden ? visible : people.isHidden.equals(false) & visible)
          ..groupBy([people.id], having: faces.id.count().isBiggerOrEqualValue(minFaces) | people.name.equals('').not())
          ..orderBy([
            if (includeHidden) OrderingTerm(expression: people.isHidden),
            OrderingTerm(expression: people.name.equals('').not(), mode: OrderingMode.desc),
            OrderingTerm(expression: faces.id.count(), mode: OrderingMode.desc),
          ]);

    return query.map((row) {
      final person = row.readTable(people);
      return person.toDto();
    }).watch();
  }

  Future<int> updateName(String personId, String name) {
    final query = _db.update(_db.personEntity)..where((row) => row.id.equals(personId));

    return query.write(PersonEntityCompanion(name: Value(name), updatedAt: Value(DateTime.now())));
  }

  Future<int> updateBirthday(String personId, DateTime birthday) {
    final query = _db.update(_db.personEntity)..where((row) => row.id.equals(personId));

    return query.write(PersonEntityCompanion(birthDate: Value(birthday), updatedAt: Value(DateTime.now())));
  }

  Future<int> updateHidden(String personId, bool isHidden) {
    final query = _db.update(_db.personEntity)..where((row) => row.id.equals(personId));

    return query.write(PersonEntityCompanion(isHidden: Value(isHidden), updatedAt: Value(DateTime.now())));
  }

  /// The person's thumbnail is now cut from [assetId]; the new [updatedAt] makes the app load it again
  Future<int> updateFeatureFace(String personId, String assetId, {DateTime? updatedAt}) {
    final query = _db.update(_db.personEntity)..where((row) => row.id.equals(personId));

    return query.write(
      PersonEntityCompanion(faceAssetId: Value(assetId), updatedAt: Value(updatedAt ?? DateTime.now())),
    );
  }

  /// The faces of [sourceIds] are now [targetId]'s, and those people are gone; as the server does, the target takes
  /// the first name and birthday of the sources (in order) it has none of
  Future<void> merge(String targetId, List<String> sourceIds) => _db.transaction(() async {
    final people = await (_db.select(_db.personEntity)..where((row) => row.id.isIn([targetId, ...sourceIds]))).get();
    final byId = {for (final person in people) person.id: person};
    final ordered = [targetId, ...sourceIds].map((id) => byId[id]).nonNulls;
    final name = ordered.map((person) => person.name).firstWhere((name) => name.isNotEmpty, orElse: () => '');
    final birthDate = ordered.map((person) => person.birthDate).nonNulls.firstOrNull;

    await (_db.update(
      _db.assetFaceEntity,
    )..where((row) => row.personId.isIn(sourceIds))).write(AssetFaceEntityCompanion(personId: Value(targetId)));
    await (_db.delete(_db.personEntity)..where((row) => row.id.isIn(sourceIds))).go();
    await (_db.update(_db.personEntity)..where((row) => row.id.equals(targetId))).write(
      PersonEntityCompanion(name: Value(name), birthDate: Value(birthDate), updatedAt: Value(DateTime.now())),
    );
  });

  /// The faces of [personId] on [assetId]
  Future<List<String>> getFaceIds(String assetId, String personId) {
    final query = _db.select(_db.assetFaceEntity)
      ..where((row) => row.assetId.equals(assetId) & row.personId.equals(personId) & row.deletedAt.isNull());

    return query.map((row) => row.id).get();
  }

  Future<String?> getOwnerId(String personId) {
    final query = _db.select(_db.personEntity)..where((row) => row.id.equals(personId));

    return query.map((row) => row.ownerId).getSingleOrNull();
  }

  Future<int> reassignFaces(List<String> faceIds, String personId) {
    final query = _db.update(_db.assetFaceEntity)..where((row) => row.id.isIn(faceIds));

    return query.write(AssetFaceEntityCompanion(personId: Value(personId)));
  }

  Future<int> deleteFaces(List<String> faceIds) {
    final query = _db.update(_db.assetFaceEntity)..where((row) => row.id.isIn(faceIds));

    return query.write(AssetFaceEntityCompanion(deletedAt: Value(DateTime.now())));
  }

  /// A person the server just made, until the sync brings it
  Future<void> insert(Person person, {required String ownerId}) {
    return _db
        .into(_db.personEntity)
        .insertOnConflictUpdate(
          PersonEntityCompanion.insert(
            id: person.id,
            ownerId: ownerId,
            name: person.name,
            isFavorite: person.isFavorite,
            isHidden: person.isHidden,
            birthDate: Value(person.birthDate),
            updatedAt: Value(person.updatedAt ?? DateTime.now()),
          ),
        );
  }
}

extension on PersonEntityData {
  Person toDto() => Person(
    id: id,
    updatedAt: updatedAt,
    name: name,
    birthDate: birthDate,
    isHidden: isHidden,
    isFavorite: isFavorite,
  );
}
