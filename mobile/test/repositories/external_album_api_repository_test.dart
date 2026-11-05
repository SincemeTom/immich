import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/server/external_album.dart';
import 'package:immich_mobile/domain/models/external_album.model.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class _MockSynologyApi extends Mock implements SynologyApi {}

void main() {
  late _MockSynologyApi api;
  late ExternalAlbumApiRepository sut;

  const report = {
    'success': true,
    'startedAt': '2026-11-05T02:59:00.000Z',
    'finishedAt': '2026-11-05T03:00:00.000Z',
    'albums': 12,
    'albumsCreated': 2,
    'albumsUpdated': 3,
    'albumsRemoved': 1,
    'albumsEmpty': 1,
    'albumsFailed': 0,
    'items': 300,
    'matched': 290,
    'matchedByName': 4,
    'ambiguous': 1,
    'added': 20,
    'removed': 2,
    'others': 5,
    'othersMatched': 3,
    'othersWaiting': 2,
    'membersAdded': 1,
    'membersUpdated': 0,
    'membersRemoved': 0,
    'membersWaiting': 1,
    'unmatched': 9,
  };

  const bound = {
    'bound': true,
    'url': 'https://nas.example.com:5001',
    'account': 'alice',
    'verifyCertificate': false,
    'albumCount': 12,
    'checkedAt': '2026-11-05T03:00:00.000Z',
    'autoSync': false,
    'syncTime': '04:30',
    'syncPending': true,
    'lastSync': report,
  };

  setUpAll(() {
    registerFallbackValue(SynologyAccountBindDto(url: '', account: ''));
    registerFallbackValue(SynologySyncScheduleDto(autoSync: true, syncTime: '03:00'));
  });

  setUp(() {
    api = _MockSynologyApi();
    sut = ExternalAlbumApiRepository(api);
  });

  test('reads the account, its schedule and the last sync', () async {
    when(() => api.getSynologyAccount()).thenAnswer((_) async => SynologyAccountResponseDto.fromJson(bound));

    final account = (await sut.getAccount())!;

    expect(account.bound, isTrue);
    expect(account.url, 'https://nas.example.com:5001');
    expect(account.account, 'alice');
    expect(account.verifyCertificate, isFalse);
    expect(account.autoSync, isFalse);
    expect(account.syncTime, '04:30');
    expect(account.syncPending, isTrue);
    expect(account.checkedAt!.isAtSameMomentAs(DateTime.utc(2026, 11, 5, 3)), isTrue);
    expect(account.lastSync!.matched, 290);
    expect(account.lastSync!.unmatched, 9);
    expect(account.lastSync!.othersWaiting, 2);
  });

  test('an unbound account takes the default schedule', () async {
    when(() => api.getSynologyAccount()).thenAnswer((_) async => SynologyAccountResponseDto(bound: false));

    final account = (await sut.getAccount())!;

    expect(account.bound, isFalse);
    expect(account.autoSync, isTrue);
    expect(account.syncTime, '03:00');
    expect(account.lastSync, isNull);
  });

  test('is null on a server without external albums (an official one)', () async {
    when(() => api.getSynologyAccount()).thenThrow(ApiException(404, '{"message":"Cannot GET /api/synology/account"}'));

    expect(await sut.getAccount(), isNull);
  });

  test('other errors are not taken for a server without external albums', () async {
    when(() => api.getSynologyAccount()).thenThrow(ApiException(500, 'boom'));

    expect(sut.getAccount(), throwsA(isA<ApiException>()));
  });

  test('binding sends the password and code only when there are some', () async {
    when(() => api.bindSynologyAccount(any())).thenAnswer(
      (_) async => SynologyAccountTestResponseDto.fromJson({
        'success': false,
        'errorReason': 'otpRequired',
        'message': 'The NAS answered with error 403',
        'account': {'bound': false},
      }),
    );

    final result = await sut.bind(url: 'nas.example.com:5001', account: 'alice', verifyCertificate: true);

    final sent = verify(() => api.bindSynologyAccount(captureAny())).captured.single as SynologyAccountBindDto;
    expect(sent.toJson(), {'url': 'nas.example.com:5001', 'account': 'alice', 'verifyCertificate': true});
    expect(result.success, isFalse);
    expect(result.errorReason, ExternalAlbumError.otpRequired);
    expect(result.errorReason!.asksForCode, isTrue);
    expect(result.message, 'The NAS answered with error 403');
  });

  test('saves the schedule', () async {
    when(
      () => api.updateSynologySyncSchedule(any()),
    ).thenAnswer((_) async => SynologyAccountResponseDto.fromJson({...bound, 'autoSync': true, 'syncTime': '05:15'}));

    final account = await sut.updateSchedule(autoSync: true, syncTime: '05:15');

    final sent = verify(() => api.updateSynologySyncSchedule(captureAny())).captured.single as SynologySyncScheduleDto;
    expect(sent.toJson(), {'autoSync': true, 'syncTime': '05:15'});
    expect(account.syncTime, '05:15');
  });

  test('reads what the last sync did not match', () async {
    when(() => api.getSynologyUnmatched()).thenAnswer(
      (_) async => [
        SynologyUnmatchedDto(albumId: 8, albumName: 'Empty', reason: SynologyUnmatchedReason.albumEmpty, mine: true),
        SynologyUnmatchedDto(
          albumId: 7,
          albumName: 'Trip',
          reason: SynologyUnmatchedReason.ownerWaiting,
          mine: false,
          path: const Optional.present('IMG_1.jpg'),
        ),
      ],
    );

    final items = await sut.unmatched();

    expect(items.first.reason, ExternalAlbumUnmatchedReason.albumEmpty);
    expect(items.first.reason.isAlbum, isTrue);
    expect(items.first.path, isNull);
    expect(items.last.reason, ExternalAlbumUnmatchedReason.ownerWaiting);
    expect(items.last.mine, isFalse);
    expect(items.last.path, 'IMG_1.jpg');
  });

  test('a reason this app does not know yet is "other"', () {
    expect(ExternalAlbumError.parse('somethingNew'), ExternalAlbumError.other);
    expect(ExternalAlbumError.parse(null), ExternalAlbumError.other);
  });
}
