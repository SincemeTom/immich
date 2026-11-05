import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/album/album_access.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/remove_from_album.action.dart';
import 'package:immich_mobile/presentation/actions/set_album_cover.action.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../../service.mocks.dart';
import '../../factories/local_asset_factory.dart';
import '../../factories/remote_album_factory.dart';
import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

void main() {
  const albumId = 'album-1';

  late PresentationContext context;
  late MockRemoteAlbumService albumService;

  setUp(() async {
    context = await PresentationContext.create();
    albumService = context.service.album.service;
    when(() => albumService.getUserRole(any(), any())).thenAnswer((_) async => AlbumUserRole.owner);
  });

  tearDown(() async {
    await context.dispose();
  });

  List<Override> withMockToast() => [toastServiceProvider.overrideWithValue(context.service.toast)];

  List<Override> withAccess(AlbumAccess access) => [myAlbumAccessProvider.overrideWith((ref, id) async => access)];

  Future<bool> isShown(WidgetTester tester, ActionBuilder action, List<Override> overrides) async {
    await tester.pumpTestWidget(context, ActionIconButton(action: action), overrides: overrides);
    return find.byType(ImmichIconButton).evaluate().isNotEmpty;
  }

  group('RemoveFromAlbumAction', () {
    const action = RemoveFromAlbumAction(source: .timeline, albumId: albumId);

    Future<void> pumpRemove(WidgetTester tester, Set<BaseAsset> selection) =>
        tester.pumpTestAction(context, action, overrides: [...context.selected(selection), ...withMockToast()]);

    testWidgets('removes every selected remote asset from the album', (tester) async {
      final first = RemoteAssetFactory.create();
      final second = RemoteAssetFactory.create();

      await pumpRemove(tester, {first, second});
      await tester.pumpAndSettle();

      verify(() => albumService.removeAssets(albumId: albumId, assetIds: [first.id, second.id])).called(1);
    });

    testWidgets('reports the count the server actually removed', (tester) async {
      when(
        () => albumService.removeAssets(
          albumId: any(named: 'albumId'),
          assetIds: any(named: 'assetIds'),
        ),
      ).thenAnswer((_) async => 1);

      await pumpRemove(tester, {RemoteAssetFactory.create(), RemoteAssetFactory.create()});
      await tester.pumpAndSettle();

      final message = verify(() => context.service.toast.success(captureAny())).captured.single as String;
      expect(message, StaticTranslations.instance.remove_from_album_action_prompt(count: 1));
    });

    testWidgets('is hidden for a local-only asset', (tester) async {
      expect(await isShown(tester, action, context.selected({LocalAssetFactory.create()})), isFalse);
    });

    testWidgets('is hidden for a viewer', (tester) async {
      final own = RemoteAssetFactory.create(ownerId: context.currentUser.id);
      expect(
        await isShown(tester, action, [
          ...context.selected({own}),
          ...withAccess(.downloader),
        ]),
        isFalse,
      );
    });

    testWidgets('lets an editor remove their own photos', (tester) async {
      final own = RemoteAssetFactory.create(ownerId: context.currentUser.id);
      expect(
        await isShown(tester, action, [
          ...context.selected({own}),
          ...withAccess(.editor),
        ]),
        isTrue,
      );
    });

    testWidgets('does not let an editor remove others\' photos', (tester) async {
      final own = RemoteAssetFactory.create(ownerId: context.currentUser.id);
      final others = RemoteAssetFactory.create();
      expect(
        await isShown(tester, action, [
          ...context.selected({own, others}),
          ...withAccess(.editor),
        ]),
        isFalse,
      );
    });

    testWidgets('lets a manager remove anyone\'s photos', (tester) async {
      final others = RemoteAssetFactory.create();
      expect(
        await isShown(tester, action, [
          ...context.selected({others}),
          ...withAccess(.manager),
        ]),
        isTrue,
      );
    });
  });

  group('SetAlbumCoverAction', () {
    const action = SetAlbumCoverAction(source: .timeline, albumId: albumId);

    testWidgets('sets the single selected asset as the cover', (tester) async {
      final asset = RemoteAssetFactory.create();
      when(
        () => albumService.updateAlbum(any(), thumbnailAssetId: any(named: 'thumbnailAssetId')),
      ).thenAnswer((_) async => RemoteAlbumFactory.create(id: albumId));

      await tester.pumpTestAction(
        context,
        action,
        overrides: [
          ...context.selected({asset}),
          ...withMockToast(),
        ],
      );
      await tester.pumpAndSettle();

      verify(() => albumService.updateAlbum(albumId, thumbnailAssetId: asset.id)).called(1);

      final message = verify(() => context.service.toast.success(captureAny())).captured.single as String;
      expect(message, StaticTranslations.instance.album_cover_updated);
    });

    testWidgets('is hidden for more than one asset', (tester) async {
      final selection = {RemoteAssetFactory.create(), RemoteAssetFactory.create()};
      expect(await isShown(tester, action, context.selected(selection)), isFalse);
    });

    testWidgets('is hidden for a local-only asset', (tester) async {
      expect(await isShown(tester, action, context.selected({LocalAssetFactory.create()})), isFalse);
    });

    testWidgets('is hidden for an editor', (tester) async {
      final asset = RemoteAssetFactory.create();
      expect(
        await isShown(tester, action, [
          ...context.selected({asset}),
          ...withAccess(.editor),
        ]),
        isFalse,
      );
    });

    testWidgets('is shown for a manager', (tester) async {
      final asset = RemoteAssetFactory.create();
      expect(
        await isShown(tester, action, [
          ...context.selected({asset}),
          ...withAccess(.manager),
        ]),
        isTrue,
      );
    });
  });
}
