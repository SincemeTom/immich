import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/tag.model.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_details/tags_details.widget.dart';
import 'package:mocktail/mocktail.dart';

import '../factories/local_asset_factory.dart';
import '../factories/remote_asset_factory.dart';
import 'presentation_context.dart';

void main() {
  late PresentationContext context;

  setUp(() async => context = await PresentationContext.create());
  tearDown(() => context.dispose());

  List<Override> tagsTurned({required bool on}) => [
    Store.userMetadata.preferences().overrideWith((ref) => Stream.value(.new(tagsEnabled: on))),
  ];

  RemoteAsset owned() => RemoteAssetFactory.create(ownerId: context.currentUser.id);

  group('TagsDetails', () {
    testWidgets("lists the owner's tags by value under a title", (tester) async {
      final asset = owned();
      when(
        context.service.tag.getForAsset,
      ).thenAnswer((_) async => const [Tag(id: 'b', value: '自动/动物/猫'), Tag(id: 'a', value: 'Travel/Japan')]);

      await tester.pumpTestWidget(context, TagsDetails(asset: asset), overrides: tagsTurned(on: true));

      expect(find.text('Tags'), findsOneWidget);
      final chips = tester.widgetList<ActionChip>(find.byType(ActionChip)).toList();
      expect(chips.map((chip) => (chip.label as Text).data), ['Travel/Japan', '自动/动物/猫']);
      verify(() => context.service.tag.repo.getForAsset(asset.id)).called(1);
    });

    testWidgets('asks for the remote asset of a backed up local one', (tester) async {
      final asset = LocalAssetFactory.create(remoteId: 'remote-id');
      when(context.service.tag.getForAsset).thenAnswer((_) async => const [Tag(id: 'a', value: 'Family')]);

      await tester.pumpTestWidget(context, TagsDetails(asset: asset), overrides: tagsTurned(on: true));

      expect(find.text('Family'), findsOneWidget);
      verify(() => context.service.tag.repo.getForAsset('remote-id')).called(1);
    });

    testWidgets('renders nothing while tags are turned off', (tester) async {
      await tester.pumpTestWidget(context, TagsDetails(asset: owned()), overrides: tagsTurned(on: false));

      expect(find.byType(Text), findsNothing);
      verifyNever(context.service.tag.getForAsset);
    });

    testWidgets("renders nothing for someone else's asset, whose tags are theirs", (tester) async {
      await tester.pumpTestWidget(
        context,
        TagsDetails(asset: RemoteAssetFactory.create()),
        overrides: tagsTurned(on: true),
      );

      expect(find.byType(Text), findsNothing);
      verifyNever(context.service.tag.getForAsset);
    });

    testWidgets('renders nothing for a local asset that is not backed up', (tester) async {
      await tester.pumpTestWidget(
        context,
        TagsDetails(asset: LocalAssetFactory.create()),
        overrides: tagsTurned(on: true),
      );

      expect(find.byType(Text), findsNothing);
      verifyNever(context.service.tag.getForAsset);
    });

    testWidgets('renders nothing for an asset without tags', (tester) async {
      when(context.service.tag.getForAsset).thenAnswer((_) async => const []);

      await tester.pumpTestWidget(context, TagsDetails(asset: owned()), overrides: tagsTurned(on: true));

      expect(find.byType(Text), findsNothing);
    });

    testWidgets('renders nothing when the tags cannot be loaded', (tester) async {
      when(context.service.tag.getForAsset).thenThrow(Exception('offline'));

      await tester.pumpTestWidget(context, TagsDetails(asset: owned()), overrides: tagsTurned(on: true));

      expect(find.byType(Text), findsNothing);
    });
  });
}
