import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';

/// What a member of an album can do, from the least to the most (as the fork server's album access, and its web):
/// a viewer sees the photos, a downloader also downloads the originals, an editor also adds photos and removes its
/// own, a manager also manages the album as its owner does (members, details, cover, shared links, any photo), the
/// owner also deletes it.
///
/// Official Immich servers know two roles: their viewers download, and their editors also manage (share, rename)
enum AlbumAccess {
  viewer,
  downloader,
  editor,
  manager,
  owner;

  bool get canDownload => index >= downloader.index;
  bool get canAddAssets => index >= editor.index;
  bool get canManage => index >= manager.index;
  bool get canDelete => this == owner;

  /// [ownAssets]: whether the photos to remove are all the user's
  bool canRemoveAssets({required bool ownAssets}) => canManage || (canAddAssets && ownAssets);

  /// A member's access from what the server says; [hasAccessLevels]: the server has the fork's levels
  static AlbumAccess fromServer(
    AlbumUserRole role, {
    required bool allowDownload,
    required bool isManager,
    required bool hasAccessLevels,
  }) => switch (role) {
    AlbumUserRole.owner => owner,
    AlbumUserRole.editor => !hasAccessLevels || isManager ? manager : editor,
    AlbumUserRole.viewer => !hasAccessLevels || allowDownload ? downloader : viewer,
  };

  /// From the role alone (the local database), while the server is not asked: the least that role may be
  static AlbumAccess fromRole(AlbumUserRole role) => switch (role) {
    AlbumUserRole.owner => owner,
    AlbumUserRole.editor => editor,
    AlbumUserRole.viewer => viewer,
  };

  /// The role the server is sent for a member's access, with the fork's flags
  ({AlbumUserRole role, bool allowDownload, bool isManager}) toServer() => switch (this) {
    manager => (role: AlbumUserRole.editor, allowDownload: true, isManager: true),
    editor => (role: AlbumUserRole.editor, allowDownload: true, isManager: false),
    downloader => (role: AlbumUserRole.viewer, allowDownload: true, isManager: false),
    viewer => (role: AlbumUserRole.viewer, allowDownload: false, isManager: false),
    owner => throw ArgumentError('A member cannot be made the owner'),
  };
}

class AlbumMember {
  final UserDto user;
  final AlbumAccess access;

  const AlbumMember({required this.user, required this.access});
}

/// An album's members as the server has them
class AlbumMembers {
  /// Owner first
  final List<AlbumMember> members;

  /// The server has the fork's five levels; otherwise only viewer and editor can be given
  final bool hasAccessLevels;

  const AlbumMembers({required this.members, required this.hasAccessLevels});

  AlbumAccess? accessOf(String userId) {
    for (final member in members) {
      if (member.user.id == userId) {
        return member.access;
      }
    }
    return null;
  }

  /// The levels a member can be given here, the most first
  List<AlbumAccess> get assignable => hasAccessLevels
      ? const [AlbumAccess.manager, AlbumAccess.editor, AlbumAccess.downloader, AlbumAccess.viewer]
      : const [AlbumAccess.manager, AlbumAccess.downloader];
}
