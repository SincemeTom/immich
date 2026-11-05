import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/presentation/pages/person_cover_picker.page.dart';
import 'package:immich_mobile/presentation/widgets/people/person_option_sheet.widget.dart';
import 'package:immich_mobile/providers/timeline/multiselect.provider.dart';

import '../../test_utils.dart';
import '../../widget_tester_extensions.dart';

void main() {
  testWidgets('the person menu has the cover photo, as the web', (tester) async {
    var picked = 0;
    await tester.pumpConsumerWidget(PersonOptionSheet(onEditName: () {}, onSelectCover: () => picked++));

    await tester.tap(find.text('Select cover photo'));
    expect(picked, 1);
  });

  testWidgets('one photo is the cover: picking another replaces it, and done gives it', (tester) async {
    final first = TestUtils.createRemoteAsset(id: 'asset-1');
    final second = TestUtils.createRemoteAsset(id: 'asset-2');
    String? result = 'not yet';

    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) => TextButton(
          onPressed: () async {
            result = await Navigator.of(context).push<String>(
              MaterialPageRoute(
                builder: (_) => ProviderScope(
                  overrides: [
                    multiSelectProvider.overrideWith(
                      () => MultiSelectNotifier(
                        const MultiSelectState(selectedAssets: {}, lockedSelectionAssets: {}, forceEnable: true),
                      ),
                    ),
                  ],
                  child: const Scaffold(body: CustomScrollView(slivers: [PersonCoverPickerAppBar()])),
                ),
              ),
            );
          },
          child: const Text('open'),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    final container = ProviderScope.containerOf(tester.element(find.byType(PersonCoverPickerAppBar)));
    TextButton done() => tester.widget<TextButton>(find.byKey(const Key('person-cover-done')));

    expect(find.text('Select cover photo'), findsOneWidget);
    expect(done().onPressed, isNull);

    container.read(multiSelectProvider.notifier).toggleAssetSelection(first);
    await tester.pump();
    container.read(multiSelectProvider.notifier).toggleAssetSelection(second);
    await tester.pump();

    expect(container.read(multiSelectProvider).selectedAssets, {second});
    await tester.tap(find.byKey(const Key('person-cover-done')));
    await tester.pumpAndSettle();
    expect(result, 'asset-2');
  });

  testWidgets('closing picks nothing', (tester) async {
    String? result = 'not yet';
    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) => TextButton(
          onPressed: () async {
            result = await Navigator.of(context).push<String>(
              MaterialPageRoute(
                builder: (_) => ProviderScope(
                  overrides: [
                    multiSelectProvider.overrideWith(
                      () => MultiSelectNotifier(
                        const MultiSelectState(selectedAssets: {}, lockedSelectionAssets: {}, forceEnable: true),
                      ),
                    ),
                  ],
                  child: const Scaffold(body: CustomScrollView(slivers: [PersonCoverPickerAppBar()])),
                ),
              ),
            );
          },
          child: const Text('open'),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pumpAndSettle();
    expect(result, isNull);
  });
}
