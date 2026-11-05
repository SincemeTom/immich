import 'package:flutter/material.dart';
import 'package:immich_mobile/domain/models/album/album_access.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';

/// The name of an access level; on official servers ([hasAccessLevels] false) by the two roles they know
String albumAccessLabel(BuildContext context, AlbumAccess access, {required bool hasAccessLevels}) {
  final t = context.t;
  return switch (access) {
    AlbumAccess.owner => t.owner,
    AlbumAccess.manager => hasAccessLevels ? t.role_manager : t.role_editor,
    AlbumAccess.editor => t.role_editor,
    AlbumAccess.downloader => hasAccessLevels ? t.role_downloader : t.role_viewer,
    AlbumAccess.viewer => t.role_viewer,
  };
}

IconData albumAccessIcon(AlbumAccess access) => switch (access) {
  AlbumAccess.owner => Icons.star_rounded,
  AlbumAccess.manager => Icons.admin_panel_settings_outlined,
  AlbumAccess.editor => Icons.edit_outlined,
  AlbumAccess.downloader => Icons.download_outlined,
  AlbumAccess.viewer => Icons.visibility_outlined,
};

/// Pick an access level among [members]' assignable ones; [extra] tiles go below (remove the member)
Future<AlbumAccess?> showAlbumAccessPicker(
  BuildContext context, {
  required String title,
  required AlbumMembers members,
  AlbumAccess? current,
  List<Widget> extra = const [],
}) {
  return showModalBottomSheet<AlbumAccess>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    backgroundColor: context.colorScheme.surfaceContainer,
    builder: (sheetContext) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.only(top: 16, bottom: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(title, style: sheetContext.textTheme.titleMedium),
            ),
            if (members.hasAccessLevels)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
                child: Text(
                  sheetContext.t.album_access_description,
                  style: sheetContext.textTheme.bodySmall?.copyWith(color: sheetContext.colorScheme.onSurfaceSecondary),
                ),
              ),
            for (final access in members.assignable)
              ListTile(
                leading: Icon(albumAccessIcon(access)),
                title: Text(albumAccessLabel(sheetContext, access, hasAccessLevels: members.hasAccessLevels)),
                trailing: access == current ? Icon(Icons.check_rounded, color: sheetContext.primaryColor) : null,
                onTap: () => Navigator.of(sheetContext).pop(access),
              ),
            if (extra.isNotEmpty) ...[const Divider(), ...extra],
          ],
        ),
      ),
    ),
  );
}
