import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/repositories/asset_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class _MockAssetsApi extends Mock implements AssetsApi {}

class _MockStacksApi extends Mock implements StacksApi {}

class _MockTrashApi extends Mock implements TrashApi {}

class _MockAssetResponseDto extends Mock implements AssetResponseDto {}

class _MockExifResponseDto extends Mock implements ExifResponseDto {}

void main() {
  late _MockAssetsApi api;
  late AssetApiRepository sut;

  setUp(() {
    api = _MockAssetsApi();
    sut = AssetApiRepository(api, _MockStacksApi(), _MockTrashApi());
  });

  group('isLocationInferred', () {
    void stubExif(Optional<ExifResponseDto?> exifInfo) {
      final asset = _MockAssetResponseDto();
      when(() => asset.exifInfo).thenReturn(exifInfo);
      when(() => api.getAssetInfo('asset')).thenAnswer((_) async => asset);
    }

    test('is true when the server says so', () async {
      final exif = _MockExifResponseDto();
      when(() => exif.locationInferred).thenReturn(const Optional.present(true));
      stubExif(Optional.present(exif));

      expect(await sut.isLocationInferred('asset'), isTrue);
    });

    test('is false when the server does not tell (an official server)', () async {
      final exif = _MockExifResponseDto();
      when(() => exif.locationInferred).thenReturn(const Optional.absent());
      stubExif(Optional.present(exif));

      expect(await sut.isLocationInferred('asset'), isFalse);
    });

    test('is false without exif', () async {
      stubExif(const Optional.absent());

      expect(await sut.isLocationInferred('asset'), isFalse);
    });
  });

  group('getInferredLocationSource', () {
    test('reads when the photo was taken as the time where it was taken', () async {
      when(() => api.getInferredLocationSource('asset')).thenAnswer(
        (_) async => LocationInferenceSourceResponseDto(
          source_: LocationInferenceSourceDto(
            assetId: 'source',
            localDateTime: '2026-05-01T14:03:00.000Z',
            ownerId: 'owner',
            ownerName: 'Tom',
          ),
        ),
      );

      final source = (await sut.getInferredLocationSource('asset'))!;

      expect(source.assetId, 'source');
      expect(source.takenAt, DateTime(2026, 5, 1, 14, 3));
      expect(source.takenAt.isUtc, isFalse);
      expect(source.ownerId, 'owner');
      expect(source.ownerName, 'Tom');
    });

    test('is null when the server no longer knows it', () async {
      when(
        () => api.getInferredLocationSource('asset'),
      ).thenAnswer((_) async => LocationInferenceSourceResponseDto(source_: null));

      expect(await sut.getInferredLocationSource('asset'), isNull);
    });
  });
}
