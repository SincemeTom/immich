import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/branded_translation_loader.dart';

void main() {
  group('rebrandText', () {
    test('names the app Pixcellar', () {
      expect(rebrandText('Upload to Immich ({count})'), 'Upload to Pixcellar ({count})');
      expect(rebrandText('Open photos in Immich'), 'Open photos in Pixcellar');
      expect(rebrandText('上传至Immich（{count}）'), '上传至Pixcellar（{count}）');
      expect(rebrandText('看看Immich有什么新变化'), '看看Pixcellar有什么新变化');
    });

    test('keeps the Immich server', () {
      expect(
        rebrandText(
          'These items will be permanently removed from your device but still be available on the Immich server',
        ),
        'These items will be permanently removed from your device but still be available on the Immich server',
      );
      expect(rebrandText('依然会保留在 Immich 服务器上'), '依然会保留在 Immich 服务器上');
      expect(rebrandText('Immich Server'), 'Immich Server');
    });

    test('keeps links and file names', () {
      expect(rebrandText('https://docs.immich.app'), 'https://docs.immich.app');
      expect(rebrandText('see Immich.app or Immich-Debug'), 'see Immich.app or Immich-Debug');
      expect(rebrandText('ImmichApp'), 'ImmichApp');
    });
  });

  test('rebrandTranslations goes into nested maps', () {
    expect(
      rebrandTranslations({
        'a': 'Immich',
        'b': {'c': 'Welcome to Immich'},
        'd': 1,
      }),
      {
        'a': 'Pixcellar',
        'b': {'c': 'Welcome to Pixcellar'},
        'd': 1,
      },
    );
  });
}
