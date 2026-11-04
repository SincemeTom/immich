import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_asset.repository.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late RemoteAssetRepository sut;

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = RemoteAssetRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  group('getByChecksum', () {
    late String userId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
    });

    test('returns all assets when a partner shares the checksum', () async {
      const checksum = 'shared-partner-checksum';
      final mine = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      final partner = await ctx.newUser();
      final theirs = await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);
      final mineResult = result.firstWhere((asset) => asset.id == mine.id);
      final theirResult = result.firstWhere((asset) => asset.id == theirs.id);

      expect(result, isNotEmpty);
      expect(mineResult.id, mine.id);
      expect(mineResult.ownerId, userId);

      expect(theirResult.id, theirs.id);
      expect(theirResult.ownerId, partner.id);
    });

    test('returns partner asset only if there is no matching user asset', () async {
      const checksum = 'partner-only';
      final partner = await ctx.newUser();
      final theirs = await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);

      expect(result.length, 1);
      expect(result[0].id, theirs.id);
    });

    test('returns the current user\'s asset', () async {
      const checksum = 'simple';
      final remote = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);

      expect(result.length, 1);
      expect(result[0].id, remote.id);
    });
  });

  group('trash', () {
    late String userId;
    late String trashedId;
    late String keptId;
    late String partnerTrashedId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      final partner = await ctx.newUser();
      trashedId = (await ctx.newRemoteAsset(ownerId: userId, deletedAt: DateTime.utc(2024))).id;
      keptId = (await ctx.newRemoteAsset(ownerId: userId)).id;
      partnerTrashedId = (await ctx.newRemoteAsset(ownerId: partner.id, deletedAt: DateTime.utc(2024))).id;
    });

    Future<Set<String>> remainingIds() async =>
        (await ctx.db.select(ctx.db.remoteAssetEntity).get()).map((row) => row.id).toSet();

    test('emptyTrash deletes the owner\'s trashed assets and returns their ids', () async {
      final ids = await sut.emptyTrash(userId);

      expect(ids, [trashedId]);
      expect(await remainingIds(), {keptId, partnerTrashedId});
    });

    test('restoreAllTrash restores the owner\'s trashed assets and returns their ids', () async {
      final ids = await sut.restoreAllTrash(userId);

      expect(ids, [trashedId]);
      final rows = await ctx.db.select(ctx.db.remoteAssetEntity).get();
      expect(rows.firstWhere((row) => row.id == trashedId).deletedAt, isNull);
      expect(rows.firstWhere((row) => row.id == partnerTrashedId).deletedAt, isNotNull);
    });

    test('return no ids when the trash is empty', () async {
      await sut.emptyTrash(userId);

      expect(await sut.emptyTrash(userId), isEmpty);
      expect(await sut.restoreAllTrash(userId), isEmpty);
    });
  });

  group('stack members', () {
    late String userId;
    late String cover;
    late String second;
    late String third;

    setUp(() async {
      userId = (await ctx.newUser()).id;
      cover = (await ctx.newRemoteAsset(ownerId: userId, createdAt: DateTime.utc(2024, 1, 3))).id;
      second = (await ctx.newRemoteAsset(ownerId: userId, createdAt: DateTime.utc(2024, 1, 2))).id;
      third = (await ctx.newRemoteAsset(ownerId: userId, createdAt: DateTime.utc(2024, 1, 1))).id;
      await sut.stack(userId, StackResponse(id: 'stack', primaryAssetId: cover, assetIds: [cover, second, third]));
    });

    test('tells the cover and what is in the stack', () async {
      final stack = await sut.watchStack('stack').first;

      expect(stack, StackResponse(id: 'stack', primaryAssetId: cover, assetIds: [cover, second, third]));
    });

    test('leaves out what is in the trash, and is null once unstacked', () async {
      await sut.trash([third]);
      expect((await sut.watchStack('stack').first)!.assetIds, [cover, second]);

      await sut.unStack(['stack']);
      expect(await sut.watchStack('stack').first, isNull);
    });

    test('a new cover', () async {
      await sut.setStackPrimary('stack', second);

      expect((await sut.watchStack('stack').first)!.primaryAssetId, second);
    });

    test('an asset taken out', () async {
      await sut.removeFromStack(third);

      expect((await sut.watchStack('stack').first)!.assetIds, [cover, second]);
      expect((await sut.get(third))!.stackId, isNull);
    });
  });
}
