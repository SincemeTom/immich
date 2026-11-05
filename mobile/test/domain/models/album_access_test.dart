import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/album/album_access.model.dart';

void main() {
  group('AlbumAccess.fromServer', () {
    AlbumAccess fork(AlbumUserRole role, {bool allowDownload = false, bool isManager = false}) =>
        AlbumAccess.fromServer(role, allowDownload: allowDownload, isManager: isManager, hasAccessLevels: true);

    AlbumAccess official(AlbumUserRole role) =>
        AlbumAccess.fromServer(role, allowDownload: false, isManager: false, hasAccessLevels: false);

    test('reads the fork levels', () {
      expect(fork(.owner), AlbumAccess.owner);
      expect(fork(.editor, allowDownload: true, isManager: true), AlbumAccess.manager);
      expect(fork(.editor, allowDownload: true), AlbumAccess.editor);
      expect(fork(.viewer, allowDownload: true), AlbumAccess.downloader);
      expect(fork(.viewer), AlbumAccess.viewer);
    });

    test('gives official viewers download and official editors management', () {
      expect(official(.owner), AlbumAccess.owner);
      expect(official(.editor), AlbumAccess.manager);
      expect(official(.viewer), AlbumAccess.downloader);
    });
  });

  test('fromRole takes the least the role may be', () {
    expect(AlbumAccess.fromRole(.owner), AlbumAccess.owner);
    expect(AlbumAccess.fromRole(.editor), AlbumAccess.editor);
    expect(AlbumAccess.fromRole(.viewer), AlbumAccess.viewer);
  });

  test('toServer round-trips through fromServer', () {
    for (final access in AlbumAccess.values.where((access) => access != AlbumAccess.owner)) {
      final sent = access.toServer();
      expect(
        AlbumAccess.fromServer(
          sent.role,
          allowDownload: sent.allowDownload,
          isManager: sent.isManager,
          hasAccessLevels: true,
        ),
        access,
      );
    }
    expect(AlbumAccess.owner.toServer, throwsArgumentError);
  });

  test('capabilities grow with the level', () {
    expect(AlbumAccess.viewer.canDownload, isFalse);
    expect(AlbumAccess.downloader.canDownload, isTrue);
    expect(AlbumAccess.downloader.canAddAssets, isFalse);
    expect(AlbumAccess.editor.canAddAssets, isTrue);
    expect(AlbumAccess.editor.canManage, isFalse);
    expect(AlbumAccess.manager.canManage, isTrue);
    expect(AlbumAccess.manager.canDelete, isFalse);
    expect(AlbumAccess.owner.canDelete, isTrue);

    expect(AlbumAccess.downloader.canRemoveAssets(ownAssets: true), isFalse);
    expect(AlbumAccess.editor.canRemoveAssets(ownAssets: true), isTrue);
    expect(AlbumAccess.editor.canRemoveAssets(ownAssets: false), isFalse);
    expect(AlbumAccess.manager.canRemoveAssets(ownAssets: false), isTrue);
  });

  test('AlbumMembers', () {
    const official = AlbumMembers(members: [], hasAccessLevels: false);
    const fork = AlbumMembers(members: [], hasAccessLevels: true);
    expect(official.assignable, [AlbumAccess.manager, AlbumAccess.downloader]);
    expect(fork.assignable, hasLength(4));
    expect(fork.accessOf('nobody'), isNull);
  });
}
