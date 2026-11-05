import 'dart:async';

import 'package:flutter/services.dart';

/// Time iOS grants to finish work once the app left the screen (about 30 seconds), before it suspends the app
abstract final class BackgroundTime {
  static const _channel = MethodChannel('app.pixcellar/background_time');

  /// Runs [body] holding that time, given back when it is done
  static Future<T> run<T>(Future<T> Function() body) async {
    int? id;
    try {
      id = await _channel.invokeMethod<int>('begin');
    } catch (_) {
      // without the extra time, the work goes on as long as iOS lets the app run
    }
    try {
      return await body();
    } finally {
      if (id != null && id >= 0) {
        unawaited(_channel.invokeMethod<void>('end', id).catchError((_) {}));
      }
    }
  }
}
