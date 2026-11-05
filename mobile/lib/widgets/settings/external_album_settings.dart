import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/external_album.dart';
import 'package:immich_mobile/domain/models/external_album.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/external_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:logging/logging.dart';

final _log = Logger('ExternalAlbumSettings');

/// The external albums, as in the web's user settings: the NAS account they are read with, and their sync
class ExternalAlbumSettingsPage extends ConsumerWidget {
  const ExternalAlbumSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(externalAlbumAccountProvider);

    return account.when(
      skipLoadingOnRefresh: true,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => ListTile(
        leading: Icon(Icons.error_outline, color: context.colorScheme.error),
        title: Text(context.t.errors.unable_to_load_synology_account),
        trailing: IconButton(
          icon: const Icon(Icons.refresh),
          onPressed: () => ref.invalidate(externalAlbumAccountProvider),
        ),
      ),
      data: (account) => account == null
          ? ListTile(leading: const Icon(Icons.info_outline), title: Text(context.t.synology_unsupported))
          : ExternalAlbumForm(initial: account),
    );
  }
}

String externalAlbumErrorText(Translations t, ExternalAlbumError? reason) =>
    switch (reason ?? ExternalAlbumError.other) {
      ExternalAlbumError.unreachable => t.synology_error_unreachable,
      ExternalAlbumError.certificate => t.synology_error_certificate,
      ExternalAlbumError.notSynology => t.synology_error_notSynology,
      ExternalAlbumError.noPhotos => t.synology_error_noPhotos,
      ExternalAlbumError.wrongPassword => t.synology_error_wrongPassword,
      ExternalAlbumError.disabled => t.synology_error_disabled,
      ExternalAlbumError.denied => t.synology_error_denied,
      ExternalAlbumError.otpRequired => t.synology_error_otpRequired,
      ExternalAlbumError.otpWrong => t.synology_error_otpWrong,
      ExternalAlbumError.otpEnforced => t.synology_error_otpEnforced,
      ExternalAlbumError.blocked => t.synology_error_blocked,
      ExternalAlbumError.passwordExpired => t.synology_error_passwordExpired,
      ExternalAlbumError.alreadyBound => t.synology_error_alreadyBound,
      ExternalAlbumError.keychain => t.synology_error_keychain,
      ExternalAlbumError.other => t.synology_error_other,
    };

/// The origin the server keeps for an address: HTTPS without a scheme, and no path
@visibleForTesting
String toOrigin(String value) {
  final text = value.trim();
  try {
    final uri = Uri.parse(
      RegExp(r'^[a-z][\d+.a-z-]*://', caseSensitive: false).hasMatch(text) ? text : 'https://$text',
    );
    return uri.origin;
  } catch (_) {
    return text;
  }
}

final _timePattern = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');
final _otpPattern = RegExp(r'^\d{6,8}$');

@visibleForTesting
class ExternalAlbumForm extends ConsumerStatefulWidget {
  final ExternalAlbumAccount initial;

  const ExternalAlbumForm({super.key, required this.initial});

  @override
  ConsumerState<ExternalAlbumForm> createState() => _ExternalAlbumFormState();
}

class _ExternalAlbumFormState extends ConsumerState<ExternalAlbumForm> {
  late ExternalAlbumAccount _account = widget.initial;
  late bool _editing = !widget.initial.bound;
  bool _busy = false;
  bool _syncing = false;

  final _url = TextEditingController();
  final _name = TextEditingController();
  final _password = TextEditingController();
  final _otp = TextEditingController();
  bool _verifyCertificate = true;
  bool _needsOtp = false;
  ({ExternalAlbumError? reason, String? message})? _failure;

  late bool _autoSync = _account.autoSync;
  late String _syncTime = _account.syncTime;

  Timer? _poll;

  ExternalAlbumApiRepository get _api => ref.read(externalAlbumApiRepositoryProvider);

  @override
  void initState() {
    super.initState();
    if (_editing) {
      _startEditing(notify: false);
    }
    _watchSync();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _url.dispose();
    _name.dispose();
    _password.dispose();
    _otp.dispose();
    super.dispose();
  }

  void _setAccount(ExternalAlbumAccount account, {bool resetSchedule = false}) {
    setState(() {
      _account = account;
      if (resetSchedule) {
        _autoSync = account.autoSync;
        _syncTime = account.syncTime;
      }
    });
    _watchSync();
  }

  /// While a sync waits or runs, what it did is read again every few seconds
  void _watchSync() {
    if (!_account.syncPending) {
      _poll?.cancel();
      _poll = null;
      return;
    }
    _poll ??= Timer.periodic(const Duration(seconds: 3), (_) async {
      try {
        final account = await _api.getAccount();
        if (mounted && account != null) {
          _setAccount(account);
        }
      } catch (_) {
        // tried again next time
      }
    });
  }

  void _startEditing({bool notify = true}) {
    _url.text = _account.url ?? '';
    _name.text = _account.account ?? '';
    _password.clear();
    _otp.clear();
    _verifyCertificate = _account.verifyCertificate;
    _needsOtp = false;
    _failure = null;
    _editing = true;
    if (notify) {
      setState(() {});
    }
  }

  /// The address and account stay, so the password kept on the server can be kept
  bool get _keepsPassword =>
      _account.bound &&
      toOrigin(_url.text) == _account.url &&
      _name.text.trim().toLowerCase() == (_account.account ?? '').toLowerCase();

  bool get _canSubmit =>
      _url.text.trim().isNotEmpty &&
      _name.text.trim().isNotEmpty &&
      (_password.text.isNotEmpty || _keepsPassword) &&
      (!_needsOtp || _otpPattern.hasMatch(_otp.text.trim()));

  bool get _scheduleChanged => _account.bound && (_autoSync != _account.autoSync || _syncTime != _account.syncTime);

  Future<void> _run(Future<void> Function() action, {required String failure}) async {
    setState(() => _busy = true);
    try {
      await action();
    } catch (error, stack) {
      _log.severe(failure, error, stack);
      ref.read(toastServiceProvider).error(failure);
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  Future<void> _onResult(ExternalAlbumResult result, String success) async {
    if (!mounted) {
      return;
    }
    if (result.success) {
      _password.clear();
      _otp.clear();
      setState(() {
        _failure = null;
        _needsOtp = false;
        _editing = false;
      });
      _setAccount(result.account, resetSchedule: true);
      await ref.read(toastServiceProvider).success(success);
      return;
    }

    setState(() {
      _account = result.account;
      _failure = (reason: result.errorReason, message: result.message);
      if (result.errorReason?.asksForCode ?? false) {
        _needsOtp = true;
        _otp.clear();
      }
    });
  }

  Future<void> _bind() async {
    if (!_canSubmit || _busy) {
      return;
    }
    final t = context.t;
    await _run(() async {
      final result = await _api.bind(
        url: _url.text.trim(),
        account: _name.text.trim(),
        password: _password.text.isEmpty ? null : _password.text,
        verifyCertificate: _verifyCertificate,
        otpCode: _needsOtp ? _otp.text.trim() : null,
      );
      await _onResult(result, t.synology_account_bound(count: result.albumCount ?? result.account.albumCount ?? 0));
    }, failure: t.errors.unable_to_bind_synology_account);
  }

  Future<void> _test() async {
    final t = context.t;
    await _run(() async {
      final result = await _api.test();
      await _onResult(result, t.synology_account_test_ok(count: result.albumCount ?? 0));
    }, failure: t.errors.unable_to_test_synology_account);
  }

  Future<void> _unbind() async {
    final t = context.t;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(
        title: t.synology_account_unbind,
        content: t.synology_account_unbind_prompt,
        ok: t.synology_account_unbind,
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    await _run(() async {
      await _api.unbind();
      if (!mounted) {
        return;
      }
      _setAccount(ExternalAlbumAccount.unbound, resetSchedule: true);
      _startEditing();
      ref.read(toastServiceProvider).success(t.synology_account_unbound);
    }, failure: t.errors.unable_to_unbind_synology_account);
  }

  Future<void> _sync() async {
    final t = context.t;
    setState(() => _syncing = true);
    try {
      final account = await _api.sync();
      if (mounted) {
        _setAccount(account);
        ref.read(toastServiceProvider).success(t.synology_sync_queued);
      }
    } catch (error, stack) {
      _log.severe('Cannot sync the external albums', error, stack);
      ref.read(toastServiceProvider).error(t.errors.unable_to_sync_synology_albums);
    } finally {
      if (mounted) {
        setState(() => _syncing = false);
      }
    }
  }

  Future<void> _saveSchedule() async {
    final t = context.t;
    await _run(() async {
      final account = await _api.updateSchedule(autoSync: _autoSync, syncTime: _syncTime);
      if (mounted) {
        _setAccount(account, resetSchedule: true);
        ref.read(toastServiceProvider).success(t.synology_sync_schedule_saved);
      }
    }, failure: t.errors.unable_to_save_synology_schedule);
  }

  Future<void> _pickTime() async {
    final parts = _syncTime.split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.tryParse(parts.first) ?? 3, minute: int.tryParse(parts.last) ?? 0),
      builder: (context, child) =>
          MediaQuery(data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: true), child: child!),
    );
    if (picked != null && mounted) {
      setState(
        () => _syncTime = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}',
      );
    }
  }

  String _formatTime(DateTime? time) =>
      time == null ? '' : DateFormat.yMMMd(context.locale.toString()).add_Hm().format(time);

  @override
  Widget build(BuildContext context) {
    final t = context.t;

    return ListView(
      padding: const EdgeInsets.only(top: 8, bottom: 32),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
          child: Text(t.synology_account_description, style: _subtitleStyle(context)),
        ),
        if (_account.bound && !_editing) ..._accountView(context) else ..._bindForm(context),
      ],
    );
  }

  List<Widget> _accountView(BuildContext context) {
    final t = context.t;
    final account = _account;
    final report = account.lastSync;

    return [
      ListTile(
        key: const Key('external-album-account'),
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        title: Text('${account.account} · ${account.url}', style: _titleStyle(context)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (account.checkedAt != null)
              Text(
                t.synology_account_checked(time: _formatTime(account.checkedAt), count: account.albumCount ?? 0),
                style: _subtitleStyle(context),
              ),
            if (!account.verifyCertificate) Text(t.synology_certificate_not_checked, style: _subtitleStyle(context)),
          ],
        ),
      ),
      if (account.errorReason != null)
        _Notice(error: true, title: externalAlbumErrorText(t, account.errorReason), detail: account.message),
      _Buttons(
        children: [
          OutlinedButton(
            onPressed: _busy ? null : _unbind,
            style: OutlinedButton.styleFrom(foregroundColor: context.colorScheme.error),
            child: Text(t.synology_account_unbind),
          ),
          OutlinedButton(onPressed: _busy ? null : _startEditing, child: Text(t.edit)),
          FilledButton(onPressed: _busy ? null : _test, child: Text(t.synology_account_test)),
        ],
      ),
      const Divider(height: 32),
      ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        title: Text(t.synology_sync, style: _titleStyle(context)),
        subtitle: Text(t.synology_sync_description, style: _subtitleStyle(context)),
      ),
      SwitchListTile.adaptive(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        dense: true,
        value: _autoSync,
        onChanged: _busy ? null : (value) => setState(() => _autoSync = value),
        activeThumbColor: context.primaryColor,
        title: Text(t.synology_sync_daily, style: _titleStyle(context)),
        subtitle: Text(t.synology_sync_daily_description, style: _subtitleStyle(context)),
      ),
      if (_autoSync)
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 20),
          title: Text(t.synology_sync_time, style: _titleStyle(context)),
          trailing: Text(_syncTime, style: context.textTheme.titleMedium),
          onTap: _busy ? null : _pickTime,
        ),
      if (_scheduleChanged)
        _Buttons(
          children: [
            OutlinedButton(
              onPressed: _busy
                  ? null
                  : () => setState(() {
                      _autoSync = account.autoSync;
                      _syncTime = account.syncTime;
                    }),
              child: Text(t.cancel),
            ),
            FilledButton(
              onPressed: _busy || (_autoSync && !_timePattern.hasMatch(_syncTime)) ? null : _saveSchedule,
              child: Text(t.save),
            ),
          ],
        )
      else if (account.autoSync && account.nextSyncAt != null)
        _Line(t.synology_sync_next(time: _formatTime(account.nextSyncAt))),
      if (report != null) ..._reportView(context, report),
      _Buttons(
        children: [
          FilledButton.icon(
            key: const Key('external-album-sync'),
            onPressed: _busy || _syncing || account.syncPending ? null : _sync,
            icon: _syncing || account.syncPending
                ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.sync),
            label: Text(account.syncPending ? t.synology_sync_pending : t.synology_sync_now),
          ),
        ],
      ),
    ];
  }

  List<Widget> _reportView(BuildContext context, ExternalAlbumSyncReport report) {
    final t = context.t;
    return [
      const SizedBox(height: 8),
      _Line(t.synology_sync_last(time: _formatTime(report.finishedAt)), primary: true),
      if (!report.success)
        _Notice(error: true, title: externalAlbumErrorText(t, report.errorReason), detail: report.message)
      else ...[
        _Line(
          t.synology_sync_albums(
            count: report.albums,
            created: report.albumsCreated,
            updated: report.albumsUpdated,
            removed: report.albumsRemoved,
          ),
        ),
        _Line(
          t.synology_sync_photos(
            matched: report.matched,
            items: report.items,
            added: report.added,
            removed: report.removed,
          ),
        ),
        if (report.matchedByName > 0) _Line(t.synology_sync_by_name(count: report.matchedByName)),
        if (report.albumsEmpty > 0) _Line(t.synology_sync_empty(count: report.albumsEmpty)),
        if (report.others > 0)
          _Line(
            t.synology_sync_others(count: report.others, matched: report.othersMatched, waiting: report.othersWaiting),
          ),
        if (report.ambiguous > 0) _Line(t.synology_sync_ambiguous(count: report.ambiguous)),
        if (report.membersAdded + report.membersUpdated + report.membersRemoved > 0)
          _Line(
            t.synology_sync_members(
              added: report.membersAdded,
              updated: report.membersUpdated,
              removed: report.membersRemoved,
            ),
          ),
        if (report.membersWaiting > 0) _Line(t.synology_sync_waiting_members(count: report.membersWaiting)),
        if (report.albumsFailed > 0)
          _Notice(error: false, title: t.synology_sync_failed_albums(count: report.albumsFailed)),
        if (report.unmatched > 0)
          ListTile(
            key: const Key('external-album-unmatched'),
            contentPadding: const EdgeInsets.symmetric(horizontal: 20),
            dense: true,
            title: Text(t.synology_sync_unmatched(count: report.unmatched), style: _titleStyle(context)),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(
              context,
            ).push(MaterialPageRoute(builder: (_) => ExternalAlbumUnmatchedPage(count: report.unmatched))),
          ),
      ],
    ];
  }

  List<Widget> _bindForm(BuildContext context) {
    final t = context.t;
    final keepsPassword = _keepsPassword;
    final failure = _failure;

    return [
      _Field(
        child: TextField(
          key: const Key('external-album-url'),
          controller: _url,
          enabled: !_busy,
          keyboardType: TextInputType.url,
          autocorrect: false,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: t.synology_address,
            helperText: t.synology_address_description,
            helperMaxLines: 3,
            hintText: 'https://nas.example.com:5001',
            border: const OutlineInputBorder(),
          ),
        ),
      ),
      _Field(
        child: TextField(
          key: const Key('external-album-account-name'),
          controller: _name,
          enabled: !_busy,
          autocorrect: false,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(labelText: t.synology_account_name, border: const OutlineInputBorder()),
        ),
      ),
      _Field(
        child: TextField(
          key: const Key('external-album-password'),
          controller: _password,
          enabled: !_busy,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: t.password,
            helperText: keepsPassword ? t.synology_password_keep : t.synology_password_description,
            border: const OutlineInputBorder(),
          ),
        ),
      ),
      SwitchListTile.adaptive(
        contentPadding: const EdgeInsets.symmetric(horizontal: 20),
        dense: true,
        value: _verifyCertificate,
        onChanged: _busy ? null : (value) => setState(() => _verifyCertificate = value),
        activeThumbColor: context.primaryColor,
        title: Text(t.synology_verify_certificate, style: _titleStyle(context)),
        subtitle: Text(t.synology_verify_certificate_description, style: _subtitleStyle(context)),
      ),
      if (_needsOtp)
        _Field(
          child: TextField(
            key: const Key('external-album-otp'),
            controller: _otp,
            enabled: !_busy,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            autofillHints: const [AutofillHints.oneTimeCode],
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              labelText: t.synology_otp_code,
              helperText: t.synology_otp_code_description,
              border: const OutlineInputBorder(),
            ),
          ),
        ),
      if (failure != null)
        _Notice(error: true, title: externalAlbumErrorText(t, failure.reason), detail: failure.message),
      _Buttons(
        children: [
          if (_account.bound)
            OutlinedButton(onPressed: _busy ? null : () => setState(() => _editing = false), child: Text(t.cancel)),
          FilledButton(
            key: const Key('external-album-bind'),
            onPressed: _busy || !_canSubmit ? null : _bind,
            child: _busy
                ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(t.synology_account_bind),
          ),
        ],
      ),
    ];
  }
}

/// The albums and photos the last sync did not match, by album; at most [_shown] photos, as on the web
class ExternalAlbumUnmatchedPage extends ConsumerWidget {
  static const _shown = 500;

  final int count;

  const ExternalAlbumUnmatchedPage({super.key, required this.count});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.t;
    final items = ref.watch(externalAlbumUnmatchedProvider);

    return Scaffold(
      appBar: AppBar(centerTitle: false, title: Text(t.synology_sync_unmatched(count: count))),
      body: items.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => ListTile(
          leading: Icon(Icons.error_outline, color: context.colorScheme.error),
          title: Text(t.errors.unable_to_load_synology_unmatched),
          trailing: IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(externalAlbumUnmatchedProvider),
          ),
        ),
        data: (items) {
          final groups = groupUnmatched(items, shown: _shown);
          final photos = items.where((item) => !item.reason.isAlbum).length;
          return ListView(
            padding: const EdgeInsets.only(bottom: 32),
            children: [
              for (final group in groups) ...[
                ListTile(
                  title: Text(group.name, style: _titleStyle(context)),
                  subtitle: group.album == null
                      ? null
                      : Text(_unmatchedText(t, group.album!), style: _subtitleStyle(context)),
                ),
                for (final photo in group.photos)
                  ListTile(
                    dense: true,
                    contentPadding: const EdgeInsets.only(left: 36, right: 16),
                    title: Text(photo.path ?? '', style: context.textTheme.bodyMedium),
                    subtitle: Text(
                      '${_unmatchedText(t, photo.reason)} · ${photo.mine ? t.synology_unmatched_mine : t.synology_unmatched_others}',
                      style: _subtitleStyle(context),
                    ),
                  ),
              ],
              if (photos > _shown) _Line(t.synology_sync_unmatched_more(count: _shown)),
            ],
          );
        },
      ),
    );
  }
}

/// The unmatched of an album: why the album itself was not made, if so, and its photos
typedef UnmatchedGroup = ({
  int id,
  String name,
  ExternalAlbumUnmatchedReason? album,
  List<ExternalAlbumUnmatched> photos,
});

/// [items] by album, in their order, with at most [shown] photos in all
@visibleForTesting
List<UnmatchedGroup> groupUnmatched(List<ExternalAlbumUnmatched> items, {required int shown}) {
  final order = <int>[];
  final names = <int, String>{};
  final albums = <int, ExternalAlbumUnmatchedReason>{};
  final photos = <int, List<ExternalAlbumUnmatched>>{};
  var count = 0;
  for (final item in items) {
    if (!names.containsKey(item.albumId)) {
      order.add(item.albumId);
      names[item.albumId] = item.albumName;
      photos[item.albumId] = [];
    }
    if (item.reason.isAlbum) {
      albums[item.albumId] = item.reason;
    } else if (count < shown) {
      photos[item.albumId]!.add(item);
      count++;
    }
  }
  return [
    for (final id in order)
      if (albums[id] != null || photos[id]!.isNotEmpty)
        (id: id, name: names[id]!, album: albums[id], photos: photos[id]!),
  ];
}

String _unmatchedText(Translations t, ExternalAlbumUnmatchedReason reason) => switch (reason) {
  ExternalAlbumUnmatchedReason.notFound => t.synology_unmatched_notFound,
  ExternalAlbumUnmatchedReason.ambiguous => t.synology_unmatched_ambiguous,
  ExternalAlbumUnmatchedReason.ownerWaiting => t.synology_unmatched_ownerWaiting,
  ExternalAlbumUnmatchedReason.albumEmpty => t.synology_unmatched_albumEmpty,
  ExternalAlbumUnmatchedReason.albumFailed => t.synology_unmatched_albumFailed,
};

TextStyle? _titleStyle(BuildContext context) =>
    context.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w500, height: 1.5);

TextStyle? _subtitleStyle(BuildContext context) =>
    context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary);

class _Field extends StatelessWidget {
  final Widget child;

  const _Field({required this.child});

  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.fromLTRB(20, 8, 20, 8), child: child);
}

class _Line extends StatelessWidget {
  final String text;
  final bool primary;

  const _Line(this.text, {this.primary = false});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 2, 20, 2),
    child: Text(text, style: primary ? context.textTheme.bodyMedium : _subtitleStyle(context)),
  );
}

class _Buttons extends StatelessWidget {
  final List<Widget> children;

  const _Buttons({required this.children});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
    child: Wrap(alignment: WrapAlignment.end, spacing: 8, runSpacing: 8, children: children),
  );
}

/// An error, or a warning, with what the NAS or the system said, in small
class _Notice extends StatelessWidget {
  final bool error;
  final String title;
  final String? detail;

  const _Notice({required this.error, required this.title, this.detail});

  @override
  Widget build(BuildContext context) {
    final background = error ? context.colorScheme.errorContainer : context.colorScheme.secondaryContainer;
    final foreground = error ? context.colorScheme.onErrorContainer : context.colorScheme.onSecondaryContainer;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Card(
        elevation: 0,
        color: background,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(error ? Icons.error_outline : Icons.warning_amber_rounded, size: 20, color: foreground),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: context.textTheme.bodyMedium?.copyWith(color: foreground)),
                    if (detail != null && detail!.isNotEmpty)
                      Text(detail!, style: context.textTheme.bodySmall?.copyWith(color: foreground)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
