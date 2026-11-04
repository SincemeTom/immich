import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/server/auto_stack.dart';
import 'package:immich_mobile/domain/models/auto_stack.model.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/widgets/settings/auto_stack_settings.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../../widget_tester_extensions.dart';

class _MockAutoStackApiRepository extends Mock implements AutoStackApiRepository {}

void main() {
  late _MockAutoStackApiRepository api;
  late MockToastService toast;

  setUpAll(() {
    registerFallbackValue(AutoStackSettings.defaults);
  });

  setUp(() {
    api = _MockAutoStackApiRepository();
    toast = MockToastService();
    when(() => toast.success(any())).thenAnswer((_) {});
    when(() => api.updateSettings(any())).thenAnswer((invocation) async => invocation.positionalArguments.first);
    when(() => api.run()).thenAnswer((_) async {});
    when(() => api.removeAll()).thenAnswer((_) async => 3);
  });

  Future<void> pump(WidgetTester tester, AutoStackSettings? settings) async {
    when(() => api.getSettings()).thenAnswer((_) async => settings);
    tester.view.physicalSize = const Size(600, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpConsumerWidget(
      const AutoStackSettingsPage(),
      overrides: [autoStackApiRepositoryProvider.overrideWithValue(api), toastServiceProvider.overrideWithValue(toast)],
    );
  }

  Future<void> tapText(WidgetTester tester, String text) async {
    await tester.tap(find.text(text));
    await tester.pumpAndSettle();
  }

  AutoStackSettings saved() => verify(() => api.updateSettings(captureAny())).captured.last as AutoStackSettings;

  testWidgets('tells when the server does not stack photos automatically', (tester) async {
    await pump(tester, null);

    expect(find.textContaining('does not stack photos automatically'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('saves the settings changed, then stacks the photos', (tester) async {
    await pump(tester, AutoStackSettings.defaults);

    await tapText(tester, 'Bursts');
    await tapText(tester, 'Looser');
    await tapText(tester, 'Save');

    expect(saved(), AutoStackSettings.defaults.copyWith(burst: false, maxDistance: 0.1));
    verify(() => api.run()).called(1);
    verify(() => toast.success('Settings saved, stacking your photos in the background')).called(1);
  });

  testWidgets('turned off, it hides the rest and saves without stacking', (tester) async {
    await pump(tester, AutoStackSettings.defaults);

    await tapText(tester, 'Enable');
    expect(find.text('Bursts'), findsNothing);
    expect(find.text('Stack again'), findsNothing);
    await tapText(tester, 'Save');

    expect(saved().enabled, isFalse);
    verifyNever(() => api.run());
  });

  testWidgets('similar photos off hides how similar', (tester) async {
    await pump(tester, AutoStackSettings.defaults);

    await tapText(tester, 'Similar photos');

    expect(find.text('Similarity'), findsNothing);
    expect(find.text('Taken within (seconds)'), findsNothing);
  });

  testWidgets('a similarity set otherwise shows as it is', (tester) async {
    await pump(tester, AutoStackSettings.defaults.copyWith(maxDistance: 0.08));

    expect(find.text('0.08'), findsOneWidget);
  });

  testWidgets('the seconds take 1 to 3600', (tester) async {
    await pump(tester, AutoStackSettings.defaults);

    await tapText(tester, 'Taken within (seconds)');
    await tester.enterText(find.byType(TextField), '4000');
    await tester.pump();
    expect(tester.widget<TextButton>(find.widgetWithText(TextButton, 'Ok')).onPressed, isNull);
    await tester.enterText(find.byType(TextField), '45');
    await tester.pump();
    await tapText(tester, 'Ok');
    await tapText(tester, 'Save');

    expect(saved().maxSeconds, 45);
  });

  testWidgets('stacking again saves, removes the automatic stacks, then stacks', (tester) async {
    await pump(tester, AutoStackSettings.defaults);

    await tapText(tester, 'Stack again');
    await tapText(tester, 'Confirm');

    verifyInOrder([() => api.updateSettings(any()), () => api.removeAll(), () => api.run()]);
  });

  testWidgets('removing the automatic stacks asks first', (tester) async {
    await pump(tester, AutoStackSettings.defaults);

    await tapText(tester, 'Remove automatic stacks');
    await tapText(tester, 'Cancel');
    verifyNever(() => api.removeAll());

    await tapText(tester, 'Remove automatic stacks');
    await tapText(tester, 'Confirm');
    verify(() => api.removeAll()).called(1);
    verifyNever(() => api.updateSettings(any()));
  });
}
