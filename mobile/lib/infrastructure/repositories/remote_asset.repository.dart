import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/db/main/table/asset/edit.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/exif.dart';
import 'package:immich_mobile/data/db/main/table/remote/exif.drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/stack.drift.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/asset_edit.model.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_asset.repository.drift.dart';
import 'package:immich_mobile/utils/option.dart';

@DriftAccessor()
class RemoteAssetRepository extends DatabaseAccessor<Drift> with $RemoteAssetRepositoryMixin {
  RemoteAssetRepository(super.attachedDatabase);

  Drift get _db => attachedDatabase;

  SingleOrNullSelectable<RemoteAsset?> _assetSelectable(String id) {
    final query =
        _db.remoteAssetEntity.select().addColumns([_db.localAssetEntity.id]).join([
            leftOuterJoin(
              _db.localAssetEntity,
              _db.remoteAssetEntity.checksum.equalsExp(_db.localAssetEntity.checksum),
              useColumns: false,
            ),
          ])
          ..where(_db.remoteAssetEntity.id.equals(id))
          ..limit(1);

    return query.map((row) {
      final asset = row.readTable(_db.remoteAssetEntity).toDto();
      return asset.copyWith(localId: row.read(_db.localAssetEntity.id));
    });
  }

  Stream<RemoteAsset?> watch(String id) {
    return _assetSelectable(id).watchSingleOrNull();
  }

  Future<RemoteAsset?> get(String id) {
    return _assetSelectable(id).getSingleOrNull();
  }

  Future<List<RemoteAsset>> getAllDebugForChecksum(String checksum) {
    final query = _db.remoteAssetEntity.select()..where((row) => row.checksum.equals(checksum));

    return query.map((row) => row.toDto()).get();
  }

  Future<List<RemoteAsset>> getStackChildren(RemoteAsset asset) {
    final stackId = asset.stackId;
    if (stackId == null) {
      return Future.value(const []);
    }

    final query = _db.remoteAssetEntity.select()
      ..where((row) => row.stackId.equals(stackId) & row.id.equals(asset.id).not())
      ..orderBy([(row) => OrderingTerm.desc(row.createdAt)]);

    return query.map((row) => row.toDto()).get();
  }

  Stream<ExifInfo?> watchExif(String id) => _db.managers.remoteExifEntity
      .filter((row) => row.assetId.id.equals(id))
      .map((row) => row.toDto())
      .watchSingleOrNull();

  Future<List<(String, String)>> getPlaces(String userId) {
    final asset = Subquery(
      _db.remoteAssetEntity.select()
        ..where((row) => row.ownerId.equals(userId))
        ..orderBy([(row) => OrderingTerm.desc(row.createdAt)]),
      "asset",
    );

    final query =
        asset.selectOnly().join([
            innerJoin(
              _db.remoteExifEntity,
              _db.remoteExifEntity.assetId.equalsExp(asset.ref(_db.remoteAssetEntity.id)),
              useColumns: false,
            ),
          ])
          ..addColumns([_db.remoteExifEntity.city, _db.remoteExifEntity.assetId])
          ..where(
            _db.remoteExifEntity.city.isNotNull() &
                asset.ref(_db.remoteAssetEntity.deletedAt).isNull() &
                asset.ref(_db.remoteAssetEntity.visibility).equals(AssetVisibility.timeline.index),
          )
          ..groupBy([_db.remoteExifEntity.city])
          ..orderBy([OrderingTerm.asc(_db.remoteExifEntity.city)]);

    return query.map((row) {
      final assetId = row.read(_db.remoteExifEntity.assetId);
      final city = row.read(_db.remoteExifEntity.city);
      return (city!, assetId!);
    }).get();
  }

  Future<void> trash(List<String> ids) {
    return _db.batch((batch) async {
      for (final id in ids) {
        batch.update(
          _db.remoteAssetEntity,
          RemoteAssetEntityCompanion(deletedAt: Value(DateTime.now())),
          where: (e) => e.id.equals(id),
        );
      }
    });
  }

  Future<void> restoreTrash(List<String> ids) {
    return _db.batch((batch) async {
      for (final id in ids) {
        batch.update(
          _db.remoteAssetEntity,
          const RemoteAssetEntityCompanion(deletedAt: Value(null)),
          where: (e) => e.id.equals(id),
        );
      }
    });
  }

  /// The ids of the assets deleted
  Future<List<String>> emptyTrash(String ownerId) {
    return _db.transaction(() async {
      final ids = await _trashedIds(ownerId);
      await _db.remoteAssetEntity.deleteWhere((t) => t.deletedAt.isNotNull() & t.ownerId.equals(ownerId));
      return ids;
    });
  }

  /// The ids of the assets restored
  Future<List<String>> restoreAllTrash(String ownerId) {
    return _db.transaction(() async {
      final ids = await _trashedIds(ownerId);
      await (_db.remoteAssetEntity.update()..where((t) => t.deletedAt.isNotNull() & t.ownerId.equals(ownerId))).write(
        const RemoteAssetEntityCompanion(deletedAt: Value(null)),
      );
      return ids;
    });
  }

  Future<List<String>> _trashedIds(String ownerId) {
    final query = _db.remoteAssetEntity.selectOnly()
      ..addColumns([_db.remoteAssetEntity.id])
      ..where(_db.remoteAssetEntity.deletedAt.isNotNull() & _db.remoteAssetEntity.ownerId.equals(ownerId));
    return query.map((row) => row.read(_db.remoteAssetEntity.id)!).get();
  }

  Future<void> deleteAssets(List<String> ids) {
    return _db.batch((batch) {
      for (final id in ids) {
        batch.deleteWhere(_db.remoteAssetEntity, (row) => row.id.equals(id));
      }
    });
  }

  Future<void> stack(String userId, StackResponse stack) {
    return _db.transaction(() async {
      final stackIds = await _db.managers.stackEntity
          .filter((row) => row.primaryAssetId.isIn(stack.assetIds))
          .map((row) => row.id)
          .get();

      await _db.batch((batch) {
        for (final stackId in stackIds) {
          batch.deleteWhere(_db.stackEntity, (row) => row.id.equals(stackId));
        }
      });

      await _db.batch((batch) {
        final companion = StackEntityCompanion(ownerId: Value(userId), primaryAssetId: Value(stack.primaryAssetId));

        batch.insert(_db.stackEntity, companion.copyWith(id: Value(stack.id)), onConflict: DoUpdate((_) => companion));

        for (final assetId in stack.assetIds) {
          batch.update(
            _db.remoteAssetEntity,
            RemoteAssetEntityCompanion(stackId: Value(stack.id)),
            where: (e) => e.id.equals(assetId),
          );
        }
      });
    });
  }

  /// The stack with its cover and the assets in it that are not in the trash; null once it is gone
  Stream<StackResponse?> watchStack(String stackId) {
    final query =
        _db.select(_db.stackEntity).join([
            innerJoin(_db.remoteAssetEntity, _db.remoteAssetEntity.stackId.equalsExp(_db.stackEntity.id)),
          ])
          ..where(_db.stackEntity.id.equals(stackId) & _db.remoteAssetEntity.deletedAt.isNull())
          ..orderBy([OrderingTerm.desc(_db.remoteAssetEntity.createdAt)]);

    return query.watch().map((rows) {
      if (rows.isEmpty) {
        return null;
      }
      final stack = rows.first.readTable(_db.stackEntity);
      return StackResponse(
        id: stack.id,
        primaryAssetId: stack.primaryAssetId,
        assetIds: rows.map((row) => row.readTable(_db.remoteAssetEntity).id).toList(growable: false),
      );
    });
  }

  Future<void> setStackPrimary(String stackId, String primaryAssetId) {
    return (_db.update(
      _db.stackEntity,
    )..where((row) => row.id.equals(stackId))).write(StackEntityCompanion(primaryAssetId: Value(primaryAssetId)));
  }

  Future<void> removeFromStack(String assetId) {
    return (_db.update(
      _db.remoteAssetEntity,
    )..where((row) => row.id.equals(assetId))).write(const RemoteAssetEntityCompanion(stackId: Value(null)));
  }

  Future<void> unStack(List<String> stackIds) {
    return _db.transaction(() async {
      await _db.batch((batch) {
        for (final stackId in stackIds) {
          batch.deleteWhere(_db.stackEntity, (row) => row.id.equals(stackId));
        }
      });

      // TODO: delete this after adding foreign key on stackId
      await _db.batch((batch) {
        for (final stackId in stackIds) {
          batch.update(
            _db.remoteAssetEntity,
            const RemoteAssetEntityCompanion(stackId: Value(null)),
            where: (e) => e.stackId.equals(stackId),
          );
        }
      });
    });
  }

  Future<void> updateDescription(String assetId, String description) async {
    await (_db.remoteExifEntity.update()..where((row) => row.assetId.equals(assetId))).write(
      RemoteExifEntityCompanion(description: Value(description)),
    );
  }

  Future<void> updateRating(String assetId, int? rating) async {
    await (_db.remoteExifEntity.update()..where((row) => row.assetId.equals(assetId))).write(
      RemoteExifEntityCompanion(rating: Value(rating)),
    );
  }

  Future<int> getCount() {
    return _db.managers.remoteAssetEntity.count();
  }

  Future<List<AssetEdit>> getAssetEdits(String assetId) {
    final query = _db.assetEditEntity.select()
      ..where((row) => row.assetId.equals(assetId) & row.action.equals(AssetEditAction.other.index).not())
      ..orderBy([(row) => OrderingTerm.asc(row.sequence)]);
    return query.map((row) => row.toDto()!).get();
  }

  Future<void> updateAssets(
    List<String> remoteIds, {
    Option<bool> isFavorite = const .none(),
    Option<AssetVisibility> visibility = const .none(),
    Option<DateTime> createdAt = const .none(),
  }) async {
    if ([isFavorite, visibility, createdAt].every((option) => option.isNone)) {
      return;
    }

    final companion = RemoteAssetEntityCompanion(
      visibility: visibility.toDriftValue(),
      isFavorite: isFavorite.toDriftValue(),
      createdAt: createdAt.toDriftValue(),
    );
    return _db.batch((batch) {
      for (final remoteId in remoteIds) {
        batch.update(_db.remoteAssetEntity, companion, where: (e) => e.id.equals(remoteId));
      }
    });
  }
}
