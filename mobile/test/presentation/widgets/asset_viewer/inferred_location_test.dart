import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/exif.model.dart';
import 'package:immich_mobile/domain/models/inferred_location.model.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_details/inferred_location.widget.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset_viewer/asset.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../../service.mocks.dart';
import '../../../unit/factories/remote_asset_factory.dart';
import '../../../widget_tester_extensions.dart';

void main() {
  final asset = RemoteAssetFactory.create(ownerId: 'owner');
  const exif = ExifInfo(latitude: 31.2, longitude: 121.5);
  final key = (assetId: asset.id, latitude: exif.latitude, longitude: exif.longitude);
  late MockAssetService assetService;

  setUp(() {
    assetService = MockAssetService();
  });

  Future<void> pump(WidgetTester tester, InferredLocation? inferred, {bool isOwner = true}) {
    return tester.pumpConsumerWidget(
      InferredLocationDetails(asset: asset, exifInfo: exif, isOwner: isOwner),
      overrides: [
        assetServiceProvider.overrideWithValue(assetService),
        inferredLocationProvider(key).overrideWith((_) async => inferred),
      ],
    );
  }

  InferredLocationSource source({String? ownerId, String ownerName = 'Tom'}) => InferredLocationSource(
    assetId: null,
    takenAt: DateTime(2026, 5, 1, 14, 3),
    ownerId: ownerId ?? asset.ownerId,
    ownerName: ownerName,
  );

  testWidgets('shows nothing for a location that is not inferred', (tester) async {
    await pump(tester, null);

    expect(find.byType(Text), findsNothing);
    expect(find.byType(IconButton), findsNothing);
  });

  testWidgets('tells it is inferred, and from which photo of the owner', (tester) async {
    await pump(tester, InferredLocation(source: source()));

    expect(find.text('Inferred'), findsOneWidget);
    expect(find.textContaining('From a photo taken at'), findsOneWidget);
    expect(find.byIcon(Icons.close), findsOneWidget);
  });

  testWidgets("names whose photo it is when it is someone else's", (tester) async {
    await pump(
      tester,
      InferredLocation(
        source: source(ownerId: 'someone-else', ownerName: 'Ann'),
      ),
      isOwner: false,
    );

    expect(find.textContaining("From Ann's photo"), findsOneWidget);
    expect(find.byIcon(Icons.close), findsNothing);
  });

  testWidgets('clears it once confirmed', (tester) async {
    when(() => assetService.clearInferredLocation(asset.id)).thenAnswer((_) async {});
    await pump(tester, const InferredLocation());

    await tester.tap(find.byIcon(Icons.close));
    await tester.pumpAndSettle();
    expect(find.text('Clear this inferred location? It will not be inferred again.'), findsOneWidget);
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();

    verify(() => assetService.clearInferredLocation(asset.id)).called(1);
  });

  testWidgets('does not clear it when cancelled', (tester) async {
    await pump(tester, const InferredLocation());

    await tester.tap(find.byIcon(Icons.close));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    verifyNever(() => assetService.clearInferredLocation(any()));
  });
}
