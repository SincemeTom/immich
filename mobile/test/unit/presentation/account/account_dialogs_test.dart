import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/account.dart';
import 'package:immich_mobile/domain/models/account.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/auth/auth_state.model.dart';
import 'package:immich_mobile/providers/account.provider.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/widgets/settings/account/account_dialogs.dart';
import 'package:mocktail/mocktail.dart';

import '../../../service.mocks.dart';
import '../presentation_context.dart';

class _MockAccountApiRepository extends Mock implements AccountApiRepository {}

class _TestAuthNotifier extends AuthNotifier {
  _TestAuthNotifier(Ref ref)
    : super(
        MockAuthService(),
        MockApiService(),
        MockUserService(),
        MockSecureStorageService(),
        MockWidgetService(),
        ref,
      ) {
    state = const AuthState(
      deviceId: 'device',
      userId: 'user',
      userEmail: 'old@example.com',
      name: 'User',
      profileImagePath: '',
      isAdmin: false,
      isAuthenticated: true,
    );
  }
}

void main() {
  late PresentationContext context;
  late _MockAccountApiRepository api;
  final t = StaticTranslations.instance;

  setUp(() async {
    context = await PresentationContext.create();
    api = _MockAccountApiRepository();
    when(() => context.service.user.service.refreshMyUser()).thenAnswer((_) async => context.currentUser);
  });

  tearDown(() async {
    await context.dispose();
  });

  Future<void> open(WidgetTester tester, Future<void> Function(BuildContext context) show) async {
    await tester.pumpTestWidget(
      context,
      Builder(
        builder: (context) => TextButton(onPressed: () => show(context), child: const Text('open')),
      ),
      overrides: [
        accountApiRepositoryProvider.overrideWithValue(api),
        accountServiceProvider.overrideWith(AccountService.new),
        toastServiceProvider.overrideWithValue(context.service.toast),
        authProvider.overrideWith(_TestAuthNotifier.new),
      ],
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(TextButton, t.save));
    await tester.pumpAndSettle();
  }

  group('change email', () {
    Future<void> openEmail(WidgetTester tester) =>
        open(tester, (context) => showChangeEmailDialog(context, email: 'old@example.com'));

    testWidgets('saves without the password when the server does not ask it', (tester) async {
      when(() => api.updateMe(email: 'new@example.com')).thenAnswer((_) async {});

      await openEmail(tester);
      await tester.enterText(find.byType(TextFormField), 'new@example.com');
      await save(tester);

      verify(() => api.updateMe(email: 'new@example.com')).called(1);
      verify(() => context.service.toast.success(t.login_email_changed)).called(1);
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('asks the current password when the server wants it', (tester) async {
      when(
        () => api.updateMe(email: 'new@example.com'),
      ).thenThrow(const AccountException(AccountError.currentPasswordRequired));
      when(() => api.updateMe(email: 'new@example.com', currentPassword: 'secret')).thenAnswer((_) async {});

      await openEmail(tester);
      await tester.enterText(find.byType(TextFormField), 'new@example.com');
      await save(tester);

      expect(find.text(t.change_email_password_description), findsOneWidget);
      expect(find.byType(AlertDialog), findsOneWidget);

      await tester.enterText(find.byType(TextFormField).last, 'secret');
      await save(tester);

      verify(() => api.updateMe(email: 'new@example.com', currentPassword: 'secret')).called(1);
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('tells a wrong password and stays open', (tester) async {
      when(
        () => api.updateMe(email: 'new@example.com'),
      ).thenThrow(const AccountException(AccountError.currentPasswordRequired));
      when(
        () => api.updateMe(email: 'new@example.com', currentPassword: 'wrong'),
      ).thenThrow(const AccountException(AccountError.wrongPassword));

      await openEmail(tester);
      await tester.enterText(find.byType(TextFormField), 'new@example.com');
      await save(tester);
      await tester.enterText(find.byType(TextFormField).last, 'wrong');
      await save(tester);

      expect(find.text(t.wrong_password), findsOneWidget);
      expect(find.byType(AlertDialog), findsOneWidget);
    });

    testWidgets('tells an email another account has', (tester) async {
      when(
        () => api.updateMe(email: 'taken@example.com'),
      ).thenThrow(const AccountException(AccountError.emailNotAvailable));

      await openEmail(tester);
      await tester.enterText(find.byType(TextFormField), 'taken@example.com');
      await save(tester);

      expect(find.text(t.email_not_available), findsOneWidget);
    });

    testWidgets('does not send an invalid email', (tester) async {
      await openEmail(tester);
      await tester.enterText(find.byType(TextFormField), 'not-an-email');
      await save(tester);

      expect(find.text(t.invalid_email), findsOneWidget);
      verifyNever(() => api.updateMe(email: any(named: 'email')));
    });
  });

  group('change password', () {
    Future<void> fill(
      WidgetTester tester, {
      required String current,
      required String next,
      required String confirm,
    }) async {
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), current);
      await tester.enterText(fields.at(1), next);
      await tester.enterText(fields.at(2), confirm);
      await save(tester);
    }

    testWidgets('changes it', (tester) async {
      when(
        () => api.changePassword(currentPassword: 'old-password', newPassword: 'new-password'),
      ).thenAnswer((_) async {});

      await open(tester, showChangePasswordDialog);
      await fill(tester, current: 'old-password', next: 'new-password', confirm: 'new-password');

      verify(() => api.changePassword(currentPassword: 'old-password', newPassword: 'new-password')).called(1);
      verify(() => context.service.toast.success(t.password_changed_others_logged_out)).called(1);
    });

    testWidgets('checks the new one before sending', (tester) async {
      await open(tester, showChangePasswordDialog);
      await fill(tester, current: 'old-password', next: 'short', confirm: 'other');

      expect(find.text(t.password_min_length), findsOneWidget);
      expect(find.text(t.change_password_form_password_mismatch), findsOneWidget);
      verifyNever(
        () => api.changePassword(
          currentPassword: any(named: 'currentPassword'),
          newPassword: any(named: 'newPassword'),
        ),
      );
    });

    testWidgets('tells a wrong current password', (tester) async {
      when(
        () => api.changePassword(currentPassword: 'wrong', newPassword: 'new-password'),
      ).thenThrow(const AccountException(AccountError.wrongPassword));

      await open(tester, showChangePasswordDialog);
      await fill(tester, current: 'wrong', next: 'new-password', confirm: 'new-password');

      expect(find.text(t.wrong_password), findsOneWidget);
      expect(find.byType(AlertDialog), findsOneWidget);
    });
  });
}
