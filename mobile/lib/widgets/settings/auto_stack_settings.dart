import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/auto_stack.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/auto_stack.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';

/// How the server stacks the user's photos by itself, as in the web's user settings
class AutoStackSettingsPage extends ConsumerWidget {
  const AutoStackSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(autoStackSettingsProvider);

    return settings.when(
      skipLoadingOnRefresh: true,
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => ListTile(
        leading: Icon(Icons.error_outline, color: context.colorScheme.error),
        title: Text(context.t.errors.unable_to_auto_stack),
        trailing: IconButton(
          icon: const Icon(Icons.refresh),
          onPressed: () => ref.invalidate(autoStackSettingsProvider),
        ),
      ),
      data: (settings) => settings == null
          ? ListTile(leading: const Icon(Icons.info_outline), title: Text(context.t.auto_stack_unsupported))
          : AutoStackForm(initial: settings),
    );
  }
}

@visibleForTesting
class AutoStackForm extends ConsumerStatefulWidget {
  final AutoStackSettings initial;

  const AutoStackForm({super.key, required this.initial});

  @override
  ConsumerState<AutoStackForm> createState() => _AutoStackFormState();
}

class _AutoStackFormState extends ConsumerState<AutoStackForm> {
  late AutoStackSettings _settings = widget.initial;
  bool _busy = false;

  static const _similarityPresets = [0.03, 0.06, 0.1];
  static const _anytimePresets = [0.01, 0.02, 0.03];

  void _update(AutoStackSettings settings) => setState(() => _settings = settings);

  Future<void> _run(Future<void> Function() action, {required String failure}) async {
    setState(() => _busy = true);
    try {
      await action();
    } catch (error, stack) {
      handleError(error, stack: stack, description: failure);
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  Future<bool> _confirm(String title, String prompt) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(title: title, content: prompt, ok: context.t.confirm),
    );
    return confirmed == true && mounted;
  }

  Future<void> _save() => _run(() async {
    final stacking = await ref.read(autoStackServiceProvider).save(_settings);
    if (mounted) {
      ref.read(toastServiceProvider).success(stacking ? context.t.auto_stack_saved_running : context.t.saved_settings);
    }
  }, failure: 'Failed to save the automatic stacking');

  Future<void> _redo() async {
    if (!await _confirm(context.t.auto_stack_redo, context.t.auto_stack_redo_prompt)) {
      return;
    }
    await _run(() async {
      final removed = await ref.read(autoStackServiceProvider).redo(_settings);
      if (mounted) {
        ref.read(toastServiceProvider).success(context.t.auto_stack_redo_done(count: removed));
      }
    }, failure: 'Failed to stack again');
  }

  Future<void> _remove() async {
    if (!await _confirm(context.t.auto_stack_remove, context.t.auto_stack_remove_prompt)) {
      return;
    }
    await _run(() async {
      final removed = await ref.read(autoStackServiceProvider).removeAll();
      if (mounted) {
        ref.read(toastServiceProvider).success(context.t.auto_stack_removed(count: removed));
      }
    }, failure: 'Failed to remove the automatic stacks');
  }

  Future<void> _editSeconds() async {
    final seconds = await showDialog<int>(
      context: context,
      builder: (_) => _SecondsDialog(seconds: _settings.maxSeconds),
    );
    if (seconds != null) {
      _update(_settings.copyWith(maxSeconds: seconds));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _settings;
    final t = context.t;

    return ListView(
      padding: const EdgeInsets.only(top: 8, bottom: 32),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
          child: Text(
            t.auto_stack_description,
            style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
          ),
        ),
        _Switch(
          title: t.enable,
          value: s.enabled,
          onChanged: (v) => _update(s.copyWith(enabled: v)),
        ),
        if (s.enabled) ...[
          _Switch(
            title: t.auto_stack_burst,
            subtitle: t.auto_stack_burst_description,
            value: s.burst,
            onChanged: (v) => _update(s.copyWith(burst: v)),
          ),
          _Switch(
            title: t.auto_stack_raw_jpeg,
            subtitle: t.auto_stack_raw_jpeg_description,
            value: s.rawJpeg,
            onChanged: (v) => _update(s.copyWith(rawJpeg: v)),
          ),
          _Switch(
            title: t.auto_stack_edited,
            subtitle: t.auto_stack_edited_description,
            value: s.edited,
            onChanged: (v) => _update(s.copyWith(edited: v)),
          ),
          _Switch(
            title: t.auto_stack_similar,
            subtitle: t.auto_stack_similar_description,
            value: s.similar,
            onChanged: (v) => _update(s.copyWith(similar: v)),
          ),
          if (s.similar) ...[
            _Choice(
              title: t.auto_stack_similarity,
              subtitle: t.auto_stack_similarity_description,
              value: s.maxDistance,
              options: {
                0.03: t.auto_stack_similarity_strict,
                0.06: t.auto_stack_similarity_default,
                0.1: t.auto_stack_similarity_loose,
              },
              presets: _similarityPresets,
              onChanged: (v) => _update(s.copyWith(maxDistance: v)),
            ),
            ListTile(
              contentPadding: _nested,
              title: Text(t.auto_stack_seconds, style: _titleStyle(context)),
              subtitle: Text(t.auto_stack_seconds_description, style: _subtitleStyle(context)),
              trailing: Text('${s.maxSeconds}', style: context.textTheme.titleMedium),
              onTap: _editSeconds,
            ),
            _Switch(
              title: t.auto_stack_anytime,
              subtitle: t.auto_stack_anytime_description,
              value: s.anytime,
              nested: true,
              onChanged: (v) => _update(s.copyWith(anytime: v)),
            ),
            if (s.anytime)
              _Choice(
                title: t.auto_stack_anytime_similarity,
                subtitle: t.auto_stack_anytime_similarity_description,
                value: s.anytimeDistance,
                options: {
                  0.01: t.auto_stack_anytime_strict,
                  0.02: t.auto_stack_similarity_strict,
                  0.03: t.auto_stack_similarity_default,
                },
                presets: _anytimePresets,
                onChanged: (v) => _update(s.copyWith(anytimeDistance: v)),
              ),
          ],
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Card(
              elevation: 0,
              color: context.colorScheme.secondaryContainer,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.info_outline, size: 20, color: context.colorScheme.onSecondaryContainer),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        t.auto_stack_note,
                        style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSecondaryContainer),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: 8,
            children: [
              FilledButton(
                onPressed: _busy ? null : _save,
                child: _busy
                    ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(t.save),
              ),
              if (s.enabled) OutlinedButton(onPressed: _busy ? null : _redo, child: Text(t.auto_stack_redo)),
              OutlinedButton(
                onPressed: _busy ? null : _remove,
                style: OutlinedButton.styleFrom(foregroundColor: context.colorScheme.error),
                child: Text(t.auto_stack_remove),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

const _nested = EdgeInsets.only(left: 36, right: 20);

TextStyle? _titleStyle(BuildContext context) =>
    context.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w500, height: 1.5);

TextStyle? _subtitleStyle(BuildContext context) =>
    context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary);

class _Switch extends StatelessWidget {
  final String title;
  final String? subtitle;
  final bool value;
  final bool nested;
  final ValueChanged<bool> onChanged;

  const _Switch({
    required this.title,
    this.subtitle,
    required this.value,
    required this.onChanged,
    this.nested = false,
  });

  @override
  Widget build(BuildContext context) {
    return SwitchListTile.adaptive(
      contentPadding: nested ? _nested : const EdgeInsets.symmetric(horizontal: 20),
      dense: true,
      value: value,
      onChanged: onChanged,
      activeThumbColor: context.primaryColor,
      title: Text(title, style: _titleStyle(context)),
      subtitle: subtitle == null ? null : Text(subtitle!, style: _subtitleStyle(context)),
    );
  }
}

/// One of a few similarities; a value set otherwise (on the web, or by an older version) shows as it is
class _Choice extends StatelessWidget {
  final String title;
  final String subtitle;
  final double value;
  final Map<double, String> options;
  final List<double> presets;
  final ValueChanged<double> onChanged;

  const _Choice({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.options,
    required this.presets,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final choices = {...options, if (!presets.contains(value)) value: '$value'};
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListTile(
            contentPadding: _nested,
            title: Text(title, style: _titleStyle(context)),
            subtitle: Text(subtitle, style: _subtitleStyle(context)),
          ),
          Padding(
            padding: _nested,
            child: SegmentedButton<double>(
              showSelectedIcon: false,
              segments: [
                for (final MapEntry(key: option, value: label) in choices.entries)
                  ButtonSegment(
                    value: option,
                    label: Text(label, textAlign: TextAlign.center),
                  ),
              ],
              selected: {value},
              onSelectionChanged: (selected) => onChanged(selected.single),
            ),
          ),
        ],
      ),
    );
  }
}

class _SecondsDialog extends StatefulWidget {
  final int seconds;

  const _SecondsDialog({required this.seconds});

  @override
  State<_SecondsDialog> createState() => _SecondsDialogState();
}

class _SecondsDialogState extends State<_SecondsDialog> {
  late final _controller = TextEditingController(text: '${widget.seconds}');

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  int? get _value {
    final value = int.tryParse(_controller.text);
    return value != null && value >= AutoStackSettings.minSeconds && value <= AutoStackSettings.maxSecondsLimit
        ? value
        : null;
  }

  @override
  Widget build(BuildContext context) {
    final value = _value;
    return AlertDialog(
      title: Text(context.t.auto_stack_seconds),
      content: TextField(
        controller: _controller,
        autofocus: true,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        decoration: const InputDecoration(
          helperText: '${AutoStackSettings.minSeconds}–${AutoStackSettings.maxSecondsLimit}',
          border: OutlineInputBorder(),
        ),
        onChanged: (_) => setState(() {}),
        onSubmitted: (_) {
          if (value != null) {
            Navigator.of(context).pop(value);
          }
        },
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(onPressed: value == null ? null : () => Navigator.of(context).pop(value), child: Text(context.t.ok)),
      ],
    );
  }
}
