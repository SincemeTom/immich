import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/account.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/account.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';

Future<void> showChangeNameDialog(BuildContext context, {required String name}) => showDialog(
  context: context,
  builder: (_) => _NameDialog(name: name),
);

Future<void> showChangeEmailDialog(BuildContext context, {required String email}) => showDialog(
  context: context,
  builder: (_) => _EmailDialog(email: email),
);

Future<void> showChangePasswordDialog(BuildContext context) =>
    showDialog(context: context, builder: (_) => const _PasswordDialog());

final _emailPattern = RegExp(r'^[^\s@]+@[^\s@]+$');

class _NameDialog extends ConsumerStatefulWidget {
  final String name;

  const _NameDialog({required this.name});

  @override
  ConsumerState<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends ConsumerState<_NameDialog> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.name);
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) {
      return;
    }
    final name = _name.text.trim();
    if (name == widget.name) {
      Navigator.of(context).pop();
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(accountServiceProvider).updateName(name);
      if (mounted) {
        ref.read(toastServiceProvider).success(context.t.change_name_successfully);
        Navigator.of(context).pop();
      }
    } catch (error, stack) {
      handleError(error, stack: stack, description: 'Failed to change the name');
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return _AccountDialog(
      title: context.t.change_name,
      busy: _busy,
      onSave: _save,
      child: Form(
        key: _form,
        child: TextFormField(
          controller: _name,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.done,
          onFieldSubmitted: (_) => _save(),
          decoration: InputDecoration(labelText: context.t.name, border: const OutlineInputBorder()),
          validator: (value) => (value ?? '').trim().isEmpty ? context.t.name : null,
        ),
      ),
    );
  }
}

/// Saves without the password first: the fork's server then asks it (and the dialog shows its field), official
/// servers do not
class _EmailDialog extends ConsumerStatefulWidget {
  final String email;

  const _EmailDialog({required this.email});

  @override
  ConsumerState<_EmailDialog> createState() => _EmailDialogState();
}

class _EmailDialogState extends ConsumerState<_EmailDialog> {
  final _form = GlobalKey<FormState>();
  late final _email = TextEditingController(text: widget.email);
  final _password = TextEditingController();
  final _passwordFocus = FocusNode();
  bool _needsPassword = false;
  bool _busy = false;
  String? _emailError;
  String? _passwordError;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _emailError = _passwordError = null);
    if (!_form.currentState!.validate()) {
      return;
    }
    final email = _email.text.trim();
    if (email.toLowerCase() == widget.email.toLowerCase()) {
      Navigator.of(context).pop();
      return;
    }
    setState(() => _busy = true);
    try {
      await ref
          .read(accountServiceProvider)
          .updateEmail(email, currentPassword: _needsPassword ? _password.text : null);
      if (mounted) {
        ref.read(toastServiceProvider).success(context.t.login_email_changed);
        Navigator.of(context).pop();
      }
      return;
    } on AccountException catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        switch (error.error) {
          case AccountError.currentPasswordRequired:
            _needsPassword = true;
          case AccountError.wrongPassword:
            _passwordError = context.t.wrong_password;
          case AccountError.emailNotAvailable:
            _emailError = context.t.email_not_available;
        }
      });
      if (error.error != AccountError.emailNotAvailable) {
        _passwordFocus.requestFocus();
      }
    } catch (error, stack) {
      handleError(error, stack: stack, description: 'Failed to change the login email');
    }
    if (mounted) {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _AccountDialog(
      title: context.t.change_login_email,
      busy: _busy,
      onSave: _save,
      child: Form(
        key: _form,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextFormField(
              controller: _email,
              autofocus: true,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              textInputAction: _needsPassword ? TextInputAction.next : TextInputAction.done,
              onFieldSubmitted: (_) => _needsPassword ? _passwordFocus.requestFocus() : _save(),
              decoration: InputDecoration(
                labelText: context.t.login_email,
                errorText: _emailError,
                border: const OutlineInputBorder(),
              ),
              validator: (value) => _emailPattern.hasMatch((value ?? '').trim()) ? null : context.t.invalid_email,
            ),
            if (_needsPassword) ...[
              const SizedBox(height: 16),
              Text(context.t.change_email_password_description, style: context.textTheme.bodyMedium),
              const SizedBox(height: 12),
              _PasswordField(
                controller: _password,
                focusNode: _passwordFocus,
                label: context.t.current_password,
                errorText: _passwordError,
                autofillHint: AutofillHints.password,
                onSubmitted: _save,
                validator: (value) => (value ?? '').isEmpty ? context.t.current_password : null,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PasswordDialog extends ConsumerStatefulWidget {
  const _PasswordDialog();

  @override
  ConsumerState<_PasswordDialog> createState() => _PasswordDialogState();
}

class _PasswordDialogState extends ConsumerState<_PasswordDialog> {
  final _form = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _new = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _currentError;

  @override
  void dispose() {
    _current.dispose();
    _new.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _currentError = null);
    if (!_form.currentState!.validate()) {
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(accountServiceProvider).changePassword(currentPassword: _current.text, newPassword: _new.text);
      if (mounted) {
        ref.read(toastServiceProvider).success(context.t.password_changed_others_logged_out);
        Navigator.of(context).pop();
      }
      return;
    } on AccountException catch (error) {
      if (mounted && error.error == AccountError.wrongPassword) {
        setState(() => _currentError = context.t.wrong_password);
      }
    } catch (error, stack) {
      handleError(error, stack: stack, description: 'Failed to change the password');
    }
    if (mounted) {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _AccountDialog(
      title: context.t.change_password,
      busy: _busy,
      onSave: _save,
      child: Form(
        key: _form,
        child: AutofillGroup(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(context.t.change_password_logs_out_others, style: context.textTheme.bodyMedium),
              const SizedBox(height: 16),
              _PasswordField(
                controller: _current,
                label: context.t.current_password,
                errorText: _currentError,
                autofocus: true,
                autofillHint: AutofillHints.password,
                validator: (value) => (value ?? '').isEmpty ? context.t.current_password : null,
              ),
              const SizedBox(height: 12),
              _PasswordField(
                controller: _new,
                label: context.t.new_password,
                autofillHint: AutofillHints.newPassword,
                validator: (value) => (value ?? '').length < 8 ? context.t.password_min_length : null,
              ),
              const SizedBox(height: 12),
              _PasswordField(
                controller: _confirm,
                label: context.t.confirm_password,
                autofillHint: AutofillHints.newPassword,
                onSubmitted: _save,
                validator: (value) => value != _new.text ? context.t.change_password_form_password_mismatch : null,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AccountDialog extends StatelessWidget {
  final String title;
  final bool busy;
  final VoidCallback onSave;
  final Widget child;

  const _AccountDialog({required this.title, required this.busy, required this.onSave, required this.child});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(title),
      content: SingleChildScrollView(child: child),
      actions: [
        TextButton(onPressed: busy ? null : () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(
          onPressed: busy ? null : onSave,
          child: busy
              ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(context.t.save),
        ),
      ],
    );
  }
}

class _PasswordField extends StatefulWidget {
  final TextEditingController controller;
  final String label;
  final String? errorText;
  final FocusNode? focusNode;
  final bool autofocus;
  final String autofillHint;
  final VoidCallback? onSubmitted;
  final FormFieldValidator<String> validator;

  const _PasswordField({
    required this.controller,
    required this.label,
    required this.autofillHint,
    required this.validator,
    this.errorText,
    this.focusNode,
    this.autofocus = false,
    this.onSubmitted,
  });

  @override
  State<_PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<_PasswordField> {
  bool _obscure = true;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: widget.controller,
      focusNode: widget.focusNode,
      autofocus: widget.autofocus,
      obscureText: _obscure,
      autocorrect: false,
      enableSuggestions: false,
      autofillHints: [widget.autofillHint],
      textInputAction: widget.onSubmitted == null ? TextInputAction.next : TextInputAction.done,
      onFieldSubmitted: widget.onSubmitted == null ? null : (_) => widget.onSubmitted!(),
      validator: widget.validator,
      decoration: InputDecoration(
        labelText: widget.label,
        errorText: widget.errorText,
        border: const OutlineInputBorder(),
        suffixIcon: IconButton(
          icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
          onPressed: () => setState(() => _obscure = !_obscure),
        ),
      ),
    );
  }
}
