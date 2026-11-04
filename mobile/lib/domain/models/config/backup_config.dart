import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

part 'backup_config.freezed.dart';

@freezed
abstract class BackupConfig with _$BackupConfig {
  const factory BackupConfig({
    @Default(false) bool enabled,
    @Default(false) bool useCellularForVideos,
    @Default(false) bool useCellularForPhotos,
    @Default(false) bool requireCharging,
    @Default(30) int triggerDelay,
    @Default(false) bool syncAlbums,

    /// iOS: how much room the files handed to the background session for upload may take, in MB
    @Default(BackupConfig.defaultQueueSizeMb) int queueSizeMb,
  }) = _BackupConfig;

  static const defaultQueueSizeMb = 2048;
  static const queueSizeOptionsMb = [512, 1024, 2048, 5120, 10240];
}
