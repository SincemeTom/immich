import 'dart:convert';
import 'dart:io';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart' hide AlbumUserRole;
import 'package:immich_mobile/domain/models/album/album.model.dart' as domain show AlbumUserRole;
import 'package:immich_mobile/domain/models/album/album_access.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/infrastructure/utils/user.converter.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/repositories/api.repository.dart';
// ignore: import_rule_openapi
import 'package:openapi/api.dart';

final albumApiRepositoryProvider = Provider((ref) => AlbumApiRepository(ref.watch(apiServiceProvider).albumsApi));

class AlbumApiRepository extends ApiRepository {
  final AlbumsApi _api;

  AlbumApiRepository(this._api);

  Future<RemoteAlbum> createDriftAlbum(
    String name,
    UserDto owner, {
    required Iterable<String> assetIds,
    String? description,
  }) async {
    final responseDto = await checkNull(
      _api.createAlbum(
        CreateAlbumDto(
          albumName: name,
          description: description == null
              ? const Optional.absent()
              : Optional.present(description.isEmpty ? null : description),
          assetIds: Optional.present(assetIds.toList()),
        ),
      ),
    );

    return responseDto.toRemoteAlbum(owner);
  }

  Future<({List<String> removed, List<String> failed})> removeAssets(String albumId, Iterable<String> assetIds) async {
    final response = await checkNull(_api.removeAssetFromAlbum(albumId, BulkIdsDto(ids: assetIds.toList())));
    final List<String> removed = [];
    final List<String> failed = [];
    for (final dto in response) {
      if (dto.success) {
        removed.add(dto.id);
      } else {
        failed.add(dto.id);
      }
    }
    return (removed: removed, failed: failed);
  }

  Future<({List<String> added, List<String> failed})> addAssets(
    String albumId,
    Iterable<String> assetIds, {
    Future<void>? abortTrigger,
  }) async {
    final response = await checkNull(
      _api.addAssetsToAlbum(albumId, BulkIdsDto(ids: assetIds.toList()), abortTrigger: abortTrigger),
    );
    final List<String> added = [];
    final List<String> failed = [];
    for (final dto in response) {
      if (dto.success) {
        added.add(dto.id);
      } else if (dto.error.orElse(null) != BulkIdErrorReason.duplicate) {
        failed.add(dto.id);
      }
    }

    return (added: added, failed: failed);
  }

  Future<RemoteAlbum> updateAlbum(
    String albumId,
    UserDto owner, {
    String? name,
    String? description,
    String? thumbnailAssetId,
    bool? isActivityEnabled,
    AlbumAssetOrder? order,
  }) async {
    AssetOrder? apiOrder;
    if (order != null) {
      apiOrder = order == AlbumAssetOrder.asc ? AssetOrder.asc : AssetOrder.desc;
    }

    final responseDto = await checkNull(
      _api.updateAlbumInfo(
        albumId,
        UpdateAlbumDto(
          albumName: name == null ? const Optional.absent() : Optional.present(name),
          description: description == null
              ? const Optional.absent()
              : Optional.present(description.isEmpty ? null : description),
          albumThumbnailAssetId: thumbnailAssetId == null
              ? const Optional.absent()
              : Optional.present(thumbnailAssetId),
          isActivityEnabled: isActivityEnabled == null ? const Optional.absent() : Optional.present(isActivityEnabled),
          order: apiOrder == null ? const Optional.absent() : Optional.present(apiOrder),
        ),
      ),
    );

    return responseDto.toRemoteAlbum(owner);
  }

  Future<void> deleteAlbum(String albumId) {
    return _api.deleteAlbum(albumId);
  }

  /// Add [userIds] as members: with [access] (the server's default, an editor, without), given as the fork's flags on a
  /// server that has its levels ([hasAccessLevels]), and as the role alone on others
  Future<void> addUsers(
    String albumId,
    Iterable<String> userIds, {
    AlbumAccess? access,
    bool hasAccessLevels = false,
  }) async {
    final server = access?.toServer();
    final albumUsers = userIds
        .map(
          (userId) => AlbumUserAddDto(
            userId: userId,
            role: server == null ? const Optional.absent() : Optional.present(server.role.toApi()),
            allowDownload: server == null || !hasAccessLevels
                ? const Optional.absent()
                : Optional.present(server.allowDownload),
            isManager: server == null || !hasAccessLevels
                ? const Optional.absent()
                : Optional.present(server.isManager),
          ),
        )
        .toList();
    await checkNull(_api.addUsersToAlbum(albumId, AddUsersDto(albumUsers: albumUsers)));
  }

  /// The album's members with what each can do. Whether the server has the fork's levels is told by its answer: an
  /// official server's members have no `isManager`
  Future<AlbumMembers> getMembers(String albumId) async {
    final response = await _api.getAlbumInfoWithHttpInfo(albumId);
    if (response.statusCode >= HttpStatus.badRequest) {
      throw ApiException(response.statusCode, utf8.decode(response.bodyBytes));
    }
    final json = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    final rawUsers = (json['albumUsers'] as List?) ?? const [];
    final hasAccessLevels = rawUsers.any((user) => user is Map && user.containsKey('isManager'));
    final album = AlbumResponseDto.fromJson(json)!;

    final members = [
      for (final member in album.albumUsers)
        AlbumMember(
          user: UserConverter.fromSimpleUserDto(member.user),
          access: AlbumAccess.fromServer(
            member.role.toDomain(),
            allowDownload: member.allowDownload,
            isManager: member.isManager,
            hasAccessLevels: hasAccessLevels,
          ),
        ),
    ]..sort((a, b) => (b.access == AlbumAccess.owner ? 1 : 0) - (a.access == AlbumAccess.owner ? 1 : 0));
    return AlbumMembers(members: members, hasAccessLevels: hasAccessLevels);
  }

  /// Give a member another access (not the owner's)
  Future<void> updateMemberAccess(
    String albumId,
    String userId,
    AlbumAccess access, {
    required bool hasAccessLevels,
  }) async {
    final server = access.toServer();
    await _api.updateAlbumUser(
      albumId,
      userId,
      UpdateAlbumUserDto(
        role: server.role.toApi(),
        allowDownload: hasAccessLevels ? Optional.present(server.allowDownload) : const Optional.absent(),
        isManager: hasAccessLevels ? Optional.present(server.isManager) : const Optional.absent(),
      ),
    );
  }

  Future<void> removeUser(String albumId, {required String userId}) async {
    await _api.removeUserFromAlbum(albumId, userId);
  }

  Future<bool> setActivityStatus(String albumId, bool isEnabled) async {
    final response = await checkNull(
      _api.updateAlbumInfo(albumId, UpdateAlbumDto(isActivityEnabled: Optional.present(isEnabled))),
    );
    return response.isActivityEnabled;
  }
}

extension on domain.AlbumUserRole {
  AlbumUserRole toApi() => switch (this) {
    domain.AlbumUserRole.owner => AlbumUserRole.owner,
    domain.AlbumUserRole.editor => AlbumUserRole.editor,
    domain.AlbumUserRole.viewer => AlbumUserRole.viewer,
  };
}

extension on AlbumUserRole {
  domain.AlbumUserRole toDomain() => switch (this) {
    AlbumUserRole.owner => domain.AlbumUserRole.owner,
    AlbumUserRole.editor => domain.AlbumUserRole.editor,
    _ => domain.AlbumUserRole.viewer,
  };
}

extension on AlbumResponseDto {
  RemoteAlbum toRemoteAlbum(final UserDto user) {
    return RemoteAlbum(
      id: id,
      name: albumName,
      ownerId: user.id,
      ownerName: user.name,
      description: description,
      createdAt: createdAt,
      updatedAt: updatedAt,
      thumbnailAssetId: albumThumbnailAssetId,
      isActivityEnabled: isActivityEnabled,
      order: order.orElse(null) == AssetOrder.asc ? AlbumAssetOrder.asc : AlbumAssetOrder.desc,
      assetCount: assetCount,
      isShared: albumUsers.length > 2,
    );
  }
}
