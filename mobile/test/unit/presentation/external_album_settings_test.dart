import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/server/external_album.dart';
import 'package:immich_mobile/domain/models/external_album.model.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/widgets/settings/external_album_settings.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../../widget_tester_extensions.dart';

class _MockExternalAlbumApiRepository extends Mock implements ExternalAlbumApiRepository {}

void main() {
  late _MockExternalAlbumApiRepository api;
  late MockToastService toast;

  final bound = ExternalAlbumAccount(
    bound: true,
    url: 'https://nas.example.com:5001',
    account: 'alice',
    albumCount: 12,
    checkedAt: DateTime(2026, 11, 5, 3),
    lastSync: ExternalAlbumSyncReport(
      success: true,
      finishedAt: DateTime(2026, 11, 5, 3),
      albums: 12,
      items: 300,
      matched: 290,
      added: 20,
      unmatched: 9,
      membersWaiting: 1,
    ),
  );

  setUp(() {
    api = _MockExternalAlbumApiRepository();
    toast = MockToastService();
    when(() => toast.success(any())).thenAnswer((_) {});
    when(() => toast.error(any())).thenAnswer((_) {});
  });

  Future<void> pump(WidgetTester tester, ExternalAlbumAccount? account) async {
    when(() => api.getAccount()).thenAnswer((_) async => account);
    tester.view.physicalSize = const Size(600, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpConsumerWidget(
      const ExternalAlbumSettingsPage(),
      overrides: [
        externalAlbumApiRepositoryProvider.overrideWithValue(api),
        toastServiceProvider.overrideWithValue(toast),
      ],
    );
  }

  Future<void> tapText(WidgetTester tester, String text) async {
    await tester.tap(find.text(text));
    await tester.pumpAndSettle();
  }

  Future<void> fillIn(WidgetTester tester) async {
    await tester.enterText(find.byKey(const Key('external-album-url')), 'nas.example.com:5001');
    await tester.enterText(find.byKey(const Key('external-album-account-name')), 'alice');
    await tester.enterText(find.byKey(const Key('external-album-password')), 'secret');
    await tester.pump();
  }

  FilledButton bindButton(WidgetTester tester) =>
      tester.widget<FilledButton>(find.byKey(const Key('external-album-bind')));

  testWidgets('tells when the server has no external albums', (tester) async {
    await pump(tester, null);

    expect(find.textContaining('has no external albums'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('no brand: the account is a NAS account', (tester) async {
    await pump(tester, ExternalAlbumAccount.unbound);

    expect(find.text('NAS address'), findsOneWidget);
    expect(find.text('NAS account'), findsOneWidget);
    expect(find.textContaining('Synology'), findsNothing);
  });

  testWidgets('binds once address, account and password are there', (tester) async {
    when(
      () => api.bind(
        url: any(named: 'url'),
        account: any(named: 'account'),
        password: any(named: 'password'),
        verifyCertificate: any(named: 'verifyCertificate'),
        otpCode: any(named: 'otpCode'),
      ),
    ).thenAnswer((_) async => ExternalAlbumResult(success: true, albumCount: 12, account: bound));
    await pump(tester, ExternalAlbumAccount.unbound);

    expect(bindButton(tester).onPressed, isNull);
    await fillIn(tester);
    expect(bindButton(tester).onPressed, isNotNull);
    await tester.tap(find.byKey(const Key('external-album-bind')));
    await tester.pumpAndSettle();

    verify(
      () => api.bind(
        url: 'nas.example.com:5001',
        account: 'alice',
        password: 'secret',
        verifyCertificate: true,
        otpCode: null,
      ),
    ).called(1);
    verify(() => toast.success('NAS account bound: 12 albums')).called(1);
    expect(find.byKey(const Key('external-album-account')), findsOneWidget);
    expect(find.text('alice · https://nas.example.com:5001'), findsOneWidget);
  });

  testWidgets('asks for the 2-step verification code when the NAS wants one, then sends it', (tester) async {
    var calls = 0;
    when(
      () => api.bind(
        url: any(named: 'url'),
        account: any(named: 'account'),
        password: any(named: 'password'),
        verifyCertificate: any(named: 'verifyCertificate'),
        otpCode: any(named: 'otpCode'),
      ),
    ).thenAnswer(
      (_) async => calls++ == 0
          ? const ExternalAlbumResult(
              success: false,
              errorReason: ExternalAlbumError.otpRequired,
              message: 'The NAS answered with error 403',
              account: ExternalAlbumAccount.unbound,
            )
          : ExternalAlbumResult(success: true, account: bound),
    );
    await pump(tester, ExternalAlbumAccount.unbound);

    await fillIn(tester);
    await tester.tap(find.byKey(const Key('external-album-bind')));
    await tester.pumpAndSettle();

    expect(find.textContaining('2-step verification on'), findsOneWidget);
    expect(find.text('The NAS answered with error 403'), findsOneWidget);
    expect(bindButton(tester).onPressed, isNull);

    await tester.enterText(find.byKey(const Key('external-album-otp')), '123456');
    await tester.pump();
    await tester.tap(find.byKey(const Key('external-album-bind')));
    await tester.pumpAndSettle();

    verify(
      () => api.bind(
        url: any(named: 'url'),
        account: any(named: 'account'),
        password: any(named: 'password'),
        verifyCertificate: any(named: 'verifyCertificate'),
        otpCode: '123456',
      ),
    ).called(1);
  });

  testWidgets('editing keeps the saved password when address and account stay', (tester) async {
    await pump(tester, bound);

    await tapText(tester, 'Edit');

    expect(find.text('Leave empty to keep the saved password'), findsOneWidget);
    expect(bindButton(tester).onPressed, isNotNull);

    await tester.enterText(find.byKey(const Key('external-album-account-name')), 'bob');
    await tester.pump();
    expect(bindButton(tester).onPressed, isNull);
  });

  testWidgets('shows the last sync, and what it did not match', (tester) async {
    when(() => api.unmatched()).thenAnswer(
      (_) async => const [
        ExternalAlbumUnmatched(
          albumId: 8,
          albumName: 'Empty',
          reason: ExternalAlbumUnmatchedReason.albumEmpty,
          mine: true,
        ),
        ExternalAlbumUnmatched(
          albumId: 7,
          albumName: 'Trip',
          reason: ExternalAlbumUnmatchedReason.notFound,
          mine: true,
          path: '2023/Trip/gone.jpg',
        ),
      ],
    );
    await pump(tester, bound);

    expect(find.text('290 of 300 photos found: 20 added, 0 removed'), findsOneWidget);
    expect(find.textContaining('1 member is not in Immich yet'), findsOneWidget);

    await tester.tap(find.byKey(const Key('external-album-unmatched')));
    await tester.pumpAndSettle();

    expect(find.text('Empty'), findsOneWidget);
    expect(find.text('Album not created: none of its photos were found'), findsOneWidget);
    expect(find.text('2023/Trip/gone.jpg'), findsOneWidget);
    expect(find.text('Not found · Mine'), findsOneWidget);
  });

  testWidgets('syncs now', (tester) async {
    when(() => api.sync()).thenAnswer((_) async => bound);
    await pump(tester, bound);

    await tester.tap(find.byKey(const Key('external-album-sync')));
    await tester.pumpAndSettle();

    verify(() => api.sync()).called(1);
    verify(() => toast.success('Syncing the albums in the background')).called(1);
  });

  testWidgets('the schedule is saved only once changed', (tester) async {
    when(
      () => api.updateSchedule(
        autoSync: any(named: 'autoSync'),
        syncTime: any(named: 'syncTime'),
      ),
    ).thenAnswer((_) async => bound);
    await pump(tester, bound);

    expect(find.text('Save'), findsNothing);
    await tapText(tester, 'Sync every day');
    expect(find.text('Sync time'), findsNothing);
    await tapText(tester, 'Save');

    verify(() => api.updateSchedule(autoSync: false, syncTime: '03:00')).called(1);
  });

  testWidgets('unbinding asks first', (tester) async {
    when(() => api.unbind()).thenAnswer((_) async {});
    await pump(tester, bound);

    await tapText(tester, 'Unbind');
    await tapText(tester, 'Cancel');
    verifyNever(() => api.unbind());

    await tapText(tester, 'Unbind');
    await tester.tap(find.text('Unbind').last);
    await tester.pumpAndSettle();

    verify(() => api.unbind()).called(1);
    expect(find.byKey(const Key('external-album-url')), findsOneWidget);
  });

  test('the address is kept as its origin, HTTPS when it has no scheme', () {
    expect(toOrigin('nas.example.com:5001'), 'https://nas.example.com:5001');
    expect(toOrigin(' http://nas.local:5000/photo/ '), 'http://nas.local:5000');
  });

  test('unmatched photos are grouped by album, at most so many', () {
    const items = [
      ExternalAlbumUnmatched(albumId: 1, albumName: 'A', reason: ExternalAlbumUnmatchedReason.notFound, mine: true),
      ExternalAlbumUnmatched(albumId: 2, albumName: 'B', reason: ExternalAlbumUnmatchedReason.albumFailed, mine: true),
      ExternalAlbumUnmatched(albumId: 1, albumName: 'A', reason: ExternalAlbumUnmatchedReason.ambiguous, mine: false),
      ExternalAlbumUnmatched(albumId: 3, albumName: 'C', reason: ExternalAlbumUnmatchedReason.notFound, mine: true),
    ];

    final groups = groupUnmatched(items, shown: 2);

    expect([for (final group in groups) group.name], ['A', 'B']);
    expect(groups.first.photos.length, 2);
    expect(groups.last.album, ExternalAlbumUnmatchedReason.albumFailed);
  });
}
