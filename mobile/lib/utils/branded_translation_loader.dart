import 'dart:ui';

import 'package:easy_localization/easy_localization.dart' show AssetLoader;
import 'package:immich_mobile/generated/codegen_loader.g.dart';

const String kAppName = 'Pixcellar';

/// "Immich" where the text means the app; the server stays an Immich server, and links, ids and file names
/// (immich.app, immich-…, Immich_…) are left alone
final RegExp _appMention = RegExp(r'(?<![\w./\-])Immich(?![\w.\-/]|\s*(?:[Ss]erver|服务器|伺服器|サーバー|서버))');

String rebrandText(String text) => text.replaceAll(_appMention, kAppName);

Map<String, dynamic> rebrandTranslations(Map<String, dynamic> translations) => {
  for (final MapEntry(:key, :value) in translations.entries)
    key: switch (value) {
      String() => rebrandText(value),
      Map<String, dynamic>() => rebrandTranslations(value),
      _ => value,
    },
};

/// The translations (shared with the web, in i18n/) with the app's name in place of Immich's
class BrandedTranslationLoader extends AssetLoader {
  const BrandedTranslationLoader();

  static final Map<String, Map<String, dynamic>?> _cache = {};

  @override
  Future<Map<String, dynamic>?> load(String path, Locale locale) async {
    final key = locale.toString();
    if (_cache.containsKey(key)) {
      return _cache[key];
    }
    final translations = await const CodegenLoader().load(path, locale);
    return _cache[key] = translations == null ? null : rebrandTranslations(translations);
  }
}
