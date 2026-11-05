import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/external_album.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final externalAlbumApiRepositoryProvider = Provider(
  (ref) => ExternalAlbumApiRepository(ref.watch(apiServiceProvider).externalAlbumsApi),
);

/// The user's external albums: the NAS account they are read with, and their sync, on the fork's server
class ExternalAlbumApiRepository extends ApiRepository {
  final SynologyApi _api;

  const ExternalAlbumApiRepository(this._api);

  /// Null when the server has no external albums (an official server)
  Future<ExternalAlbumAccount?> getAccount() async {
    try {
      return toAccount(await checkNull(_api.getSynologyAccount()));
    } on ApiException catch (error) {
      if (error.code == 404) {
        return null;
      }
      rethrow;
    }
  }

  /// Logs in to the NAS with the account, and keeps it when that works. Without [password], the one kept is used
  Future<ExternalAlbumResult> bind({
    required String url,
    required String account,
    String? password,
    required bool verifyCertificate,
    String? otpCode,
  }) async => _toResult(
    await checkNull(
      _api.bindSynologyAccount(
        SynologyAccountBindDto(
          url: url,
          account: account,
          password: password == null ? const Optional.absent() : Optional.present(password),
          verifyCertificate: Optional.present(verifyCertificate),
          otpCode: otpCode == null ? const Optional.absent() : Optional.present(otpCode),
        ),
      ),
    ),
  );

  /// Logs in to the NAS with the account kept
  Future<ExternalAlbumResult> test() async => _toResult(await checkNull(_api.testSynologyAccount()));

  Future<void> unbind() => _api.unbindSynologyAccount();

  /// Syncs the albums now, in the background on the server
  Future<ExternalAlbumAccount> sync() async => toAccount(await checkNull(_api.syncSynologyAccount()));

  Future<ExternalAlbumAccount> updateSchedule({required bool autoSync, required String syncTime}) async => toAccount(
    await checkNull(_api.updateSynologySyncSchedule(SynologySyncScheduleDto(autoSync: autoSync, syncTime: syncTime))),
  );

  /// What the last sync did not match: albums and photos
  Future<List<ExternalAlbumUnmatched>> unmatched() async => [
    for (final dto in await checkNull(_api.getSynologyUnmatched()))
      ExternalAlbumUnmatched(
        albumId: dto.albumId,
        albumName: dto.albumName,
        reason: ExternalAlbumUnmatchedReason.parse(dto.reason.toJson()),
        mine: dto.mine,
        path: dto.path.orElse(null),
      ),
  ];

  static ExternalAlbumResult _toResult(SynologyAccountTestResponseDto dto) => ExternalAlbumResult(
    success: dto.success,
    albumCount: dto.albumCount.orElse(null),
    errorReason: _reason(dto.errorReason.orElse(null)),
    message: dto.message.orElse(null),
    account: toAccount(dto.account),
  );

  static ExternalAlbumAccount toAccount(SynologyAccountResponseDto dto) {
    final report = dto.lastSync.orElse(null);
    return ExternalAlbumAccount(
      bound: dto.bound,
      url: dto.url.orElse(null),
      account: dto.account.orElse(null),
      verifyCertificate: dto.verifyCertificate.orElse(null) ?? true,
      albumCount: dto.albumCount.orElse(null),
      checkedAt: _date(dto.checkedAt.orElse(null)),
      errorReason: _reason(dto.errorReason.orElse(null)),
      message: dto.message.orElse(null),
      autoSync: dto.autoSync.orElse(null) ?? true,
      syncTime: dto.syncTime.orElse(null) ?? ExternalAlbumAccount.defaultSyncTime,
      nextSyncAt: _date(dto.nextSyncAt.orElse(null)),
      syncPending: dto.syncPending.orElse(null) ?? false,
      lastSync: report == null ? null : _toReport(report),
    );
  }

  static ExternalAlbumSyncReport _toReport(SynologySyncReportDto dto) => ExternalAlbumSyncReport(
    success: dto.success,
    finishedAt: _date(dto.finishedAt) ?? DateTime.now(),
    errorReason: _reason(dto.errorReason.orElse(null)),
    message: dto.message.orElse(null),
    albums: dto.albums,
    albumsCreated: dto.albumsCreated,
    albumsUpdated: dto.albumsUpdated,
    albumsRemoved: dto.albumsRemoved,
    albumsEmpty: dto.albumsEmpty,
    albumsFailed: dto.albumsFailed,
    items: dto.items,
    matched: dto.matched,
    matchedByName: dto.matchedByName,
    ambiguous: dto.ambiguous,
    added: dto.added,
    removed: dto.removed,
    others: dto.others,
    othersMatched: dto.othersMatched,
    othersWaiting: dto.othersWaiting,
    membersAdded: dto.membersAdded,
    membersUpdated: dto.membersUpdated,
    membersRemoved: dto.membersRemoved,
    membersWaiting: dto.membersWaiting,
    unmatched: dto.unmatched,
  );

  static ExternalAlbumError? _reason(SynologyErrorReason? reason) =>
      reason == null ? null : ExternalAlbumError.parse(reason.toJson());

  static DateTime? _date(String? value) => value == null ? null : DateTime.tryParse(value)?.toLocal();
}
