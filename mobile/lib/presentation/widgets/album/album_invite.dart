import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/album/album_access.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/album/album_access_picker.widget.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

/// Pick people to invite to [album] and, where the server has the levels, what they can do (an editor unless changed,
/// as on the web); then add them
Future<void> inviteAlbumUsers(BuildContext context, WidgetRef ref, RemoteAlbum album) async {
  final newUsers = await context.pushRoute<List<String>>(UserSelectionRoute(album: album));
  if (newUsers == null || newUsers.isEmpty || !context.mounted) {
    return;
  }

  AlbumMembers? members;
  try {
    members = await ref.read(albumMembersProvider(album.id).future);
  } catch (_) {
    // offline or refused: the server's default
  }
  if (!context.mounted) {
    return;
  }

  AlbumAccess? access;
  final hasAccessLevels = members?.hasAccessLevels ?? false;
  if (members != null && hasAccessLevels) {
    access = await showAlbumAccessPicker(
      context,
      title: context.t.album_invite_as,
      members: members,
      current: AlbumAccess.editor,
    );
    if (access == null || !context.mounted) {
      return;
    }
  }

  try {
    await ref
        .read(remoteAlbumProvider.notifier)
        .addUsers(album.id, newUsers, access: access, hasAccessLevels: hasAccessLevels);
    ref.invalidate(remoteAlbumSharedUsersProvider(album.id));
    ref.invalidate(albumMembersProvider(album.id));
    if (context.mounted) {
      ImmichToast.show(
        context: context,
        msg: context.t.users_added_to_album_count(count: newUsers.length),
        toastType: ToastType.success,
      );
    }
  } catch (_) {
    if (context.mounted) {
      ImmichToast.show(context: context, msg: context.t.errors.unable_to_add_album_users, toastType: ToastType.error);
    }
  }
}
