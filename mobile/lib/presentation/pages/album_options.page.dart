import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:fluttertoast/fluttertoast.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/album/album_access.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/pages/user_selection.page.dart';
import 'package:immich_mobile/presentation/widgets/album/album_access_picker.widget.dart';
import 'package:immich_mobile/presentation/widgets/album/album_invite.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/current_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/common/user_circle_avatar.dart';

@RoutePage()
class AlbumOptionsPage extends HookConsumerWidget {
  final RemoteAlbum album;
  const AlbumOptionsPage({super.key, required this.album});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sharedUsersAsync = ref.watch(remoteAlbumSharedUsersProvider(album.id));
    final members = ref.watch(albumMembersProvider(album.id)).valueOrNull;
    final userId = ref.watch(authProvider).userId;
    final activityEnabled = useState(album.isActivityEnabled);
    final isOwner = album.ownerId == userId;
    final myAccess = ref.watch(myAlbumAccessProvider(album.id)).valueOrNull ?? (isOwner ? AlbumAccess.owner : null);
    final canManage = myAccess?.canManage ?? false;
    final owner = isOwner ? ref.watch(currentUserProvider) : null;
    final allUsers = isOwner ? null : ref.watch(usersProvider);

    void refreshMembers() {
      ref.invalidate(remoteAlbumSharedUsersProvider(album.id));
      ref.invalidate(albumMembersProvider(album.id));
    }

    void showErrorMessage() {
      ContextHelper(context).pop();
      ImmichToast.show(
        context: context,
        msg: context.t.shared_album_section_people_action_error,
        toastType: ToastType.error,
        gravity: ToastGravity.BOTTOM,
      );
    }

    Future<void> leaveAlbum() async {
      try {
        await ref.read(remoteAlbumProvider.notifier).leaveAlbum(album.id, userId: userId);
        if (!context.mounted) {
          return;
        }

        unawaited(context.navigateTo(const AlbumsRoute()));
      } catch (_) {
        showErrorMessage();
      }
    }

    Future<void> removeUserFromAlbum(UserDto user) async {
      try {
        await ref.read(remoteAlbumProvider.notifier).removeUser(album.id, user.id);
        refreshMembers();
      } catch (_) {
        showErrorMessage();
      }

      ContextHelper(context).pop();
    }

    Future<void> changeAccess(UserDto user, AlbumAccess access) async {
      if (members == null) {
        return;
      }
      try {
        await ref
            .read(remoteAlbumProvider.notifier)
            .updateMemberAccess(album.id, user.id, access, hasAccessLevels: members.hasAccessLevels);
        refreshMembers();
        if (context.mounted) {
          ImmichToast.show(context: context, msg: context.t.album_member_access_updated, toastType: ToastType.success);
        }
      } catch (_) {
        if (context.mounted) {
          ImmichToast.show(
            context: context,
            msg: context.t.errors.unable_to_change_album_user_role,
            toastType: ToastType.error,
          );
        }
      }
    }

    Future<void> addUsers() => inviteAlbumUsers(context, ref, album);

    Future<void> handleUserClick(UserDto user) async {
      if (user.id == userId) {
        await showModalBottomSheet(
          backgroundColor: context.colorScheme.surfaceContainer,
          context: context,
          builder: (sheetContext) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.only(top: 24.0),
              child: ListTile(
                leading: const Icon(Icons.exit_to_app_rounded),
                title: Text(context.t.leave_album),
                onTap: leaveAlbum,
              ),
            ),
          ),
        );
        return;
      }

      // a manager gives the others a level, or removes them (not the owner)
      final current = members?.accessOf(user.id);
      if (members == null || current == AlbumAccess.owner) {
        return;
      }
      final access = await showAlbumAccessPicker(
        context,
        title: user.name,
        members: members,
        current: current,
        extra: [
          ListTile(
            leading: Icon(Icons.person_remove_rounded, color: context.colorScheme.error),
            title: Text(context.t.remove_user, style: TextStyle(color: context.colorScheme.error)),
            onTap: () => removeUserFromAlbum(user),
          ),
        ],
      );
      if (access != null && access != current) {
        await changeAccess(user, access);
      }
    }

    Widget? accessLabel(String id) {
      final access = members?.accessOf(id);
      if (access == null) {
        return null;
      }
      return Text(
        albumAccessLabel(context, access, hasAccessLevels: members!.hasAccessLevels),
        style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
      );
    }

    Widget buildOwnerInfo() {
      if (isOwner) {
        return ListTile(
          leading: owner != null ? UserCircleAvatar(user: owner) : const SizedBox(),
          title: Text(album.ownerName, style: const TextStyle(fontWeight: FontWeight.w500)),
          subtitle: Text(owner?.email ?? "", style: TextStyle(color: context.colorScheme.onSurfaceSecondary)),
          trailing: Text(context.t.owner, style: context.textTheme.labelLarge),
        );
      } else {
        if (allUsers == null) {
          return const SizedBox();
        }

        return allUsers.maybeWhen(
          data: (users) {
            final user = users.firstWhereOrNull((u) => u.id == album.ownerId);

            if (user == null) {
              return const SizedBox();
            }

            return ListTile(
              leading: UserCircleAvatar(user: user),
              title: Text(user.name, style: const TextStyle(fontWeight: FontWeight.w500)),
              subtitle: Text(user.email, style: TextStyle(color: context.colorScheme.onSurfaceSecondary)),
              trailing: Text(context.t.owner, style: context.textTheme.labelLarge),
            );
          },
          orElse: () => const SizedBox(),
        );
      }
    }

    Widget buildSharedUsersList() {
      return sharedUsersAsync.maybeWhen(
        data: (sharedUsers) => ListView.builder(
          primary: false,
          shrinkWrap: true,
          itemCount: sharedUsers.length,
          itemBuilder: (context, index) {
            final user = sharedUsers[index];
            final canTap = userId == user.id || (canManage && members != null);
            final label = accessLabel(user.id);
            return ListTile(
              leading: UserCircleAvatar(user: user),
              title: Text(user.name, style: const TextStyle(fontWeight: FontWeight.w500)),
              subtitle: Text(user.email, style: TextStyle(color: context.colorScheme.onSurfaceSecondary)),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ?label,
                  if (canTap) ...[const SizedBox(width: 8), const Icon(Icons.more_horiz_rounded)],
                ],
              ),
              onTap: canTap ? () => handleUserClick(user) : null,
            );
          },
        ),
        orElse: () => const Center(child: CircularProgressIndicator()),
      );
    }

    Padding buildSectionTitle(String text) {
      return Padding(
        padding: const EdgeInsets.all(16.0),
        child: Text(text, style: context.textTheme.bodySmall),
      );
    }

    return ProviderScope(
      overrides: [currentRemoteAlbumScopedProvider.overrideWithValue(album)],
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.arrow_back_ios_new_rounded),
            onPressed: () => context.maybePop(null),
          ),
          centerTitle: true,
          title: Text(context.t.options),
        ),
        body: ListView(
          children: [
            const SizedBox(height: 8),
            if (canManage)
              SwitchListTile.adaptive(
                value: activityEnabled.value,
                onChanged: (bool value) async {
                  activityEnabled.value = value;
                  await ref.read(remoteAlbumProvider.notifier).setActivityStatus(album.id, value);
                },
                activeThumbColor: activityEnabled.value ? context.primaryColor : context.themeData.disabledColor,
                dense: true,
                title: Text(
                  context.t.comments_and_likes,
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w500),
                ),
                subtitle: Text(
                  context.t.let_others_respond,
                  style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
            buildSectionTitle(context.t.shared_album_section_people_title),
            if (canManage) ...[
              ListTile(
                leading: const Icon(Icons.person_add_rounded),
                title: Text(context.t.invite_people),
                onTap: () async => addUsers(),
              ),
              const Divider(indent: 16),
            ],
            buildOwnerInfo(),
            buildSharedUsersList(),
          ],
        ),
      ),
    );
  }
}
