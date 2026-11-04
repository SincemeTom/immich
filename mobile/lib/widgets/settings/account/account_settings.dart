import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/account.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/account.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/settings/account/account_dialogs.dart';
import 'package:immich_ui/immich_ui.dart';

/// The user's name, login email and password, and the devices logged in to the account
class AccountSettings extends ConsumerWidget {
  const AccountSettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(currentUserProvider);

    return RefreshIndicator(
      onRefresh: () => ref.refresh(authSessionsProvider.future),
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 16),
        children: [
          SettingGroupTitle(title: context.t.account_profile, icon: Icons.person_outline),
          SettingListTile(
            title: context.t.name,
            subtitle: user?.name,
            trailing: const Icon(Icons.edit_outlined, size: 20),
            onTap: user == null ? null : () => showChangeNameDialog(context, name: user.name),
          ),
          SettingListTile(
            title: context.t.login_email,
            subtitle: user?.email,
            trailing: const Icon(Icons.edit_outlined, size: 20),
            onTap: user == null ? null : () => showChangeEmailDialog(context, email: user.email),
          ),
          const SizedBox(height: 16),
          SettingGroupTitle(title: context.t.password, icon: Icons.lock_outline),
          SettingListTile(
            title: context.t.change_password,
            subtitle: context.t.change_password_logs_out_others,
            trailing: const Icon(Icons.chevron_right),
            onTap: () => showChangePasswordDialog(context),
          ),
          const SizedBox(height: 16),
          SettingGroupTitle(title: context.t.logged_in_devices, icon: Icons.devices_outlined),
          const _Sessions(),
        ],
      ),
    );
  }
}

class _Sessions extends ConsumerWidget {
  const _Sessions();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(authSessionsProvider);

    return sessions.when(
      skipLoadingOnRefresh: true,
      loading: () => const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (error, _) => ListTile(
        leading: Icon(Icons.error_outline, color: context.colorScheme.error),
        title: Text(context.t.errors.unable_to_load_devices),
        trailing: IconButton(icon: const Icon(Icons.refresh), onPressed: () => ref.invalidate(authSessionsProvider)),
      ),
      data: (sessions) {
        final hasOthers = sessions.any((session) => !session.current);
        return Column(
          children: [
            for (final session in sessions) _SessionTile(session),
            if (hasOthers)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.logout),
                    label: Text(context.t.log_out_other_devices),
                    style: OutlinedButton.styleFrom(foregroundColor: context.colorScheme.error),
                    onPressed: () => _logOutOthers(context, ref),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  Future<void> _logOutOthers(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => ConfirmDialog(
        title: context.t.log_out_other_devices,
        content: context.t.log_out_other_devices_confirmation,
        ok: context.t.device_log_out,
      ),
    );
    if (confirmed != true) {
      return;
    }
    try {
      await ref.read(accountServiceProvider).logOutOtherSessions();
      if (context.mounted) {
        ref.read(toastServiceProvider).success(context.t.logged_out_other_devices);
      }
    } catch (error, stack) {
      handleError(error, stack: stack, description: 'Failed to log out the other devices');
    }
  }
}

class _SessionTile extends ConsumerWidget {
  final AuthSession session;

  const _SessionTile(this.session);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = _name(context);
    final lastActive = DateFormat.yMMMd(context.locale.toString()).add_Hm().format(session.updatedAt);

    return ListTile(
      leading: Icon(_icon, color: context.primaryColor),
      title: Text(name),
      subtitle: Text(session.current ? context.t.this_device : context.t.device_last_active(date: lastActive)),
      trailing: session.current
          ? Icon(Icons.check_circle, color: context.primaryColor)
          : IconButton(
              icon: Icon(Icons.logout, color: context.colorScheme.error),
              tooltip: context.t.device_log_out,
              onPressed: () => _logOut(context, ref, name),
            ),
    );
  }

  /// As the web: `macOS • Chrome`; the app's version after, when it is one
  String _name(BuildContext context) {
    final os = session.deviceOS.isEmpty ? null : session.deviceOS;
    final type = session.deviceType.isEmpty ? null : session.deviceType;
    if (os == null && type == null) {
      return context.t.unknown;
    }
    final version = session.appVersion;
    return [os, type].nonNulls.join(' • ') + (version == null || version.isEmpty ? '' : ' (v$version)');
  }

  IconData get _icon {
    final os = session.deviceOS.toLowerCase();
    final type = session.deviceType.toLowerCase();
    if (os == 'ios' || type == 'ios' || os.contains('iphone') || os.contains('ipad')) {
      return Icons.phone_iphone;
    }
    if (os == 'android' || type == 'android') {
      return Icons.phone_android;
    }
    if (os.contains('mac') || os.contains('windows') || os.contains('linux') || os.contains('ubuntu')) {
      return Icons.laptop;
    }
    if (os.contains('cast')) {
      return Icons.cast;
    }
    return Icons.devices_other;
  }

  Future<void> _logOut(BuildContext context, WidgetRef ref, String name) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => ConfirmDialog(
        title: context.t.device_log_out,
        content: context.t.device_log_out_confirmation(device: name),
        ok: context.t.device_log_out,
      ),
    );
    if (confirmed != true) {
      return;
    }
    try {
      await ref.read(accountServiceProvider).logOutSession(session.id);
      if (context.mounted) {
        ref.read(toastServiceProvider).success(context.t.device_logged_out);
      }
    } catch (error, stack) {
      handleError(error, stack: stack, description: 'Failed to log out a device');
    }
  }
}
