import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/asset/asset_metadata.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/asset.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/infrastructure/repositories/backup.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/local_asset.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/storage.repository.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/storage.provider.dart';
import 'package:immich_mobile/repositories/asset_media.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/utils/debug_print.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart' as api;
import 'package:path/path.dart' as p;
import 'package:photo_manager/photo_manager.dart' show PMProgressHandler;

part 'background_upload.service.freezed.dart';

final backgroundUploadServiceProvider = Provider((ref) {
  final db = ref.watch(driftProvider);
  final service = BackgroundUploadService(
    ref.watch(uploadRepositoryProvider),
    ref.watch(storageRepositoryProvider),
    db.localAssetRepository,
    db.backupRepository,
    ref.watch(assetMediaRepositoryProvider),
    ref.watch(assetServiceProvider),
  );

  ref.onDispose(service.dispose);
  return service;
});

/// Metadata for upload tasks to track live photo handling
@Freezed(fromJson: false, toJson: false)
abstract class UploadTaskMetadata with _$UploadTaskMetadata {
  const UploadTaskMetadata._();

  const factory UploadTaskMetadata({
    required String localAssetId,
    required bool isLivePhotos,
    required String livePhotoVideoId,
    String? checksum,
  }) = _UploadTaskMetadata;

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'localAssetId': localAssetId,
      'isLivePhotos': isLivePhotos,
      'livePhotoVideoId': livePhotoVideoId,
      'checksum': checksum,
    };
  }

  factory UploadTaskMetadata.fromMap(Map<String, dynamic> map) {
    return UploadTaskMetadata(
      localAssetId: map['localAssetId'] as String,
      isLivePhotos: map['isLivePhotos'] as bool,
      livePhotoVideoId: map['livePhotoVideoId'] as String,
      checksum: map['checksum'] as String?,
    );
  }

  factory UploadTaskMetadata.fromJson(String source) =>
      UploadTaskMetadata.fromMap(json.decode(source) as Map<String, dynamic>);

  String toJson() => json.encode(toMap());
}

/// Service for handling background uploads using iOS URLSession (background_downloader)
///
/// This service handles asynchronous background uploads that can continue
/// even when the app is suspended. Primarily used for iOS background backup.
class BackgroundUploadService {
  BackgroundUploadService(
    this._uploadRepository,
    this._storageRepository,
    this._localAssetRepository,
    this._backupRepository,
    this._assetMediaRepository,
    this._assetService,
  ) {
    _uploadRepository.onUploadStatus = _onUploadCallback;
    _uploadRepository.onTaskProgress = _onTaskProgressCallback;
  }

  final UploadRepository _uploadRepository;
  final StorageRepository _storageRepository;
  final LocalAssetRepository _localAssetRepository;
  final BackupRepository _backupRepository;
  final AssetMediaRepository _assetMediaRepository;
  final AssetService _assetService;
  final Logger _logger = Logger('BackgroundUploadService');

  final StreamController<TaskStatusUpdate> _taskStatusController = StreamController<TaskStatusUpdate>.broadcast();
  final StreamController<TaskProgressUpdate> _taskProgressController = StreamController<TaskProgressUpdate>.broadcast();

  // ignore: unused-code
  Stream<TaskStatusUpdate> get taskStatusStream => _taskStatusController.stream;
  // ignore: unused-code
  Stream<TaskProgressUpdate> get taskProgressStream => _taskProgressController.stream;

  bool shouldAbortQueuingTasks = false;

  void _onTaskProgressCallback(TaskProgressUpdate update) {
    if (!_taskProgressController.isClosed) {
      _taskProgressController.add(update);
    }
  }

  void _onUploadCallback(TaskStatusUpdate update) {
    if (!_taskStatusController.isClosed) {
      _taskStatusController.add(update);
    }
    unawaited(_handleTaskStatusUpdate(update));
  }

  void dispose() {
    unawaited(_taskStatusController.close());
    unawaited(_taskProgressController.close());
  }

  /// Enqueue tasks to the background upload queue
  Future<List<bool>> enqueueTasks(List<UploadTask> tasks) {
    final result = _enqueuing.then((_) => _enqueue(tasks));
    _enqueuing = result.then((_) {}, onError: (_) {});
    return result;
  }

  /// One enqueue at a time, to tell which file each one wrote
  static Future<void> _enqueuing = Future.value();

  /// On iOS each upload is sent from a copy of its file the session writes as it is queued, with the form around it
  /// (named by a UUID in the temporary folder, and left there once the upload is over)
  static final Map<String, String> _sessionFileOf = {};

  static final _sessionFileName = RegExp(r'^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$');

  @visibleForTesting
  static Future<Set<String>> Function() listSessionFiles = () async {
    try {
      return {
        await for (final entry in Directory.systemTemp.list(followLinks: false))
          if (entry is File && _sessionFileName.hasMatch(p.basename(entry.path))) entry.path,
      };
    } catch (_) {
      return {};
    }
  };

  /// How much room the temporary folder takes: the files exported from the photo library and their copies in the
  /// session
  @visibleForTesting
  static Future<int> Function() measureTempUsage = () async {
    var total = 0;
    try {
      await for (final entry in Directory.systemTemp.list(recursive: true, followLinks: false)) {
        if (entry is File) {
          total += await entry.length().catchError((_) => 0);
        }
      }
    } catch (_) {
      // what could be measured
    }
    return total;
  };

  Future<List<bool>> _enqueue(List<UploadTask> tasks) async {
    if (!CurrentPlatform.isIOS) {
      return _uploadRepository.enqueueBackgroundAll(tasks);
    }
    final results = <bool>[];
    for (final task in tasks) {
      final before = await listSessionFiles();
      final queued = (await _uploadRepository.enqueueBackgroundAll([task])).firstOrNull ?? false;
      results.add(queued);
      if (!queued) {
        continue;
      }
      final written = (await listSessionFiles()).difference(before);
      if (written.length != 1) {
        continue;
      }
      _sessionFileOf[task.taskId] = written.single;
      // the session sends its copy: a backup upload is not retried from the export (see [buildUploadTask])
      if (isBackupTask(task)) {
        await _deleteQuietly(await task.filePath());
      }
    }
    return results;
  }

  static Future<void> _deleteQuietly(String path) async {
    try {
      await File(path).delete();
    } catch (_) {
      // already gone, or with the temporary folder at the latest
    }
  }

  /// Removes the files of an upload that is over
  Future<void> _deleteFilesOf(Task task) async {
    final sessionFile = _sessionFileOf.remove(task.taskId);
    if (sessionFile != null) {
      await _deleteQuietly(sessionFile);
    }
    await _deleteQuietly(await task.filePath());
  }

  /// Get a list of tasks that are ENQUEUED or RUNNING
  Future<List<Task>> getActiveTasks(String group) {
    return _uploadRepository.getActiveTasks(group);
  }

  /// The backup uploads queued or running in the background session
  Future<List<Task>> getActiveBackupTasks() async => [
    for (final group in const [kBackupGroup, kBackupLivePhotoGroup]) ...await _uploadRepository.getActiveTasks(group),
  ];

  static bool isBackupTask(Task task) => task.group == kBackupGroup || task.group == kBackupLivePhotoGroup;

  /// Gives the background session the next backup uploads, as long as the temporary folder takes less than
  /// [limitBytes] (the backup setting by default). The session always gets at least one, however large
  ///
  /// The session uploads them while the app is suspended. Each one is queued as soon as its file is exported from the
  /// photo library. Queuing stops at [deadline] (the time iOS leaves before suspending the app) or once [shouldStop]
  /// says so (checked before each export: an exported file is always queued). Assets in [skip] are left out, and so
  /// are those needing Wi-Fi when not [onWifi]. [onPreparing], [onICloudProgress] and [onPrepared] tell about each
  /// export
  ///
  /// Returns the number of uploads queued
  Future<int> uploadBackupCandidates(
    String userId, {
    int? limitBytes,
    DateTime? deadline,
    bool Function()? shouldStop,
    Set<String> skip = const {},
    bool onWifi = true,
    void Function(LocalAsset asset)? onPreparing,
    void Function(LocalAsset asset, double progress)? onICloudProgress,
    void Function(LocalAsset asset, bool queued)? onPrepared,
  }) async {
    final limit = limitBytes ?? SettingsRepository.instance.appConfig.backup.queueSizeMb * 1024 * 1024;
    final active = await getActiveBackupTasks();
    // a task is known by its asset: queuing it again would mix the two up
    final inSession = {for (final task in active) task.taskId};
    // the uploads in the app and in the session read their files from the temporary folder
    if (!ForegroundUploadService.isUploading && active.isEmpty) {
      await _storageRepository.clearCache();
      _sessionFileOf.clear();
    }
    shouldAbortQueuingTasks = false;

    Future<bool> isFull() async => inSession.isNotEmpty && await measureTempUsage() >= limit;
    if (await isFull()) {
      return 0;
    }

    final candidates = await _backupRepository.getCandidates(userId);
    var queued = 0;
    for (final asset in candidates) {
      if (shouldAbortQueuingTasks ||
          (shouldStop?.call() ?? false) ||
          (deadline != null && DateTime.now().isAfter(deadline))) {
        break;
      }
      if (inSession.contains(asset.id) || skip.contains(asset.id) || (!onWifi && _shouldRequireWiFi(asset))) {
        continue;
      }
      if (await isFull()) {
        break;
      }
      onPreparing?.call(asset);
      final task = await getUploadTask(
        asset,
        onICloudProgress: onICloudProgress == null ? null : (progress) => onICloudProgress(asset, progress),
      );
      final queue = task != null && !shouldAbortQueuingTasks && (await enqueueTasks([task])).first;
      if (queue) {
        inSession.add(asset.id);
        queued++;
      }
      onPrepared?.call(asset, queue);
    }

    if (queued > 0) {
      final usage = await measureTempUsage();
      _logger.info(
        "Enqueued $queued background upload tasks, ${inSession.length} in the session (${usage ~/ (1024 * 1024)} MB)",
      );
    }
    return queued;
  }

  /// Cancel all ongoing background uploads and reset the upload queue
  ///
  /// Returns the number of tasks left in the queue
  Future<int> cancel() async {
    shouldAbortQueuingTasks = true;

    if (!ForegroundUploadService.isUploading) {
      await _storageRepository.clearCache();
    }
    await _uploadRepository.reset(kBackupGroup);
    await _uploadRepository.deleteDatabaseRecords(kBackupGroup);

    final activeTasks = await _uploadRepository.getActiveTasks(kBackupGroup);
    return activeTasks.length;
  }

  /// Resume background backup processing
  Future<void> resume() {
    return _uploadRepository.start();
  }

  Future<void> _handleTaskStatusUpdate(TaskStatusUpdate update) async {
    switch (update.status) {
      case TaskStatus.complete:
        unawaited(_handleLivePhoto(update));
        unawaited(_stackEditedAsset(update));

        if (CurrentPlatform.isIOS) {
          await _deleteFilesOf(update.task);
        }

      case TaskStatus.failed || TaskStatus.canceled || TaskStatus.notFound:
        if (CurrentPlatform.isIOS && isBackupTask(update.task)) {
          await _deleteFilesOf(update.task);
        }

      default:
        break;
    }
  }

  Future<void> _handleLivePhoto(TaskStatusUpdate update) async {
    try {
      if (update.task.metaData.isEmpty || update.task.metaData == '') {
        return;
      }

      final metadata = UploadTaskMetadata.fromJson(update.task.metaData);
      if (!metadata.isLivePhotos) {
        return;
      }

      if (update.responseBody == null || update.responseBody!.isEmpty) {
        return;
      }
      final response = jsonDecode(update.responseBody!);

      final localAsset = await _localAssetRepository.getById(metadata.localAssetId);
      if (localAsset == null) {
        return;
      }

      final uploadTask = await getLivePhotoUploadTask(localAsset, response['id'] as String);

      if (uploadTask == null) {
        return;
      }

      await enqueueTasks([uploadTask]);
    } catch (error, stackTrace) {
      dPrint(() => "Error handling live photo upload task: $error $stackTrace");
    }
  }

  Future<void> _stackEditedAsset(TaskStatusUpdate update) async {
    try {
      if (update.task.metaData.isEmpty || update.responseBody == null || update.responseBody!.isEmpty) {
        return;
      }

      final metadata = UploadTaskMetadata.fromJson(update.task.metaData);
      // The video half of a live photo carries isLivePhotos; the still that follows is the final asset
      if (metadata.isLivePhotos) {
        return;
      }

      await _assetService.stackEditedUpload(
        metadata.localAssetId,
        jsonDecode(update.responseBody!)['id'] as String,
        metadata.checksum,
      );
    } catch (error, stackTrace) {
      dPrint(() => "Error stacking edited asset upload: $error $stackTrace");
    }
  }

  /// [onICloudProgress] tells how the download from iCloud of a file that is only there goes
  @visibleForTesting
  Future<UploadTask?> getUploadTask(
    LocalAsset asset, {
    String group = kBackupGroup,
    int? priority,
    void Function(double progress)? onICloudProgress,
  }) async {
    final entity = await _storageRepository.getAssetEntityForAsset(asset);
    if (entity == null) {
      _logger.warning("Asset entity not found for ${asset.id} - ${asset.name}");
      return null;
    }

    File? file;

    if (onICloudProgress != null &&
        CurrentPlatform.isIOS &&
        !await _storageRepository.isAssetAvailableLocally(asset.id)) {
      _logger.info("Loading iCloud asset ${asset.id} - ${asset.name}");
      final progressHandler = PMProgressHandler();
      final subscription = progressHandler.stream.listen((event) => onICloudProgress(event.progress));
      try {
        file = entity.isLivePhoto
            ? await _storageRepository.loadMotionFileFromCloud(asset.id, progressHandler: progressHandler)
            : await _storageRepository.loadFileFromCloud(asset.id, progressHandler: progressHandler);
      } finally {
        await subscription.cancel();
      }
    }

    /// iOS LivePhoto has two files: a photo and a video.
    /// They are uploaded separately, with video file being upload first, then returned with the assetId
    /// The assetId is then used as a metadata for the photo file upload task.
    ///
    /// We implement two separate upload groups for this, the normal one for the video file
    /// and the higher priority group for the photo file because the video file is already uploaded.
    ///
    /// The cancel operation will only cancel the video group (normal group), the photo group will not
    /// be touched, as the video file is already uploaded.

    if (file != null) {
      // from iCloud
    } else if (entity.isLivePhoto) {
      file = await _storageRepository.getMotionFileForAsset(asset);
    } else {
      file = await _storageRepository.getFileForAsset(asset.id);
    }

    if (file == null) {
      _logger.warning("Failed to get file for asset ${asset.id} - ${asset.name}");
      return null;
    }

    final fileName = await _assetMediaRepository.getOriginalFilename(asset.id) ?? asset.name;
    // Some apps (e.g. DJI/Fusion) return names without an extension; fall back to the asset name for those.
    final extension = p.extension(file.path).isNotEmpty ? p.extension(file.path) : p.extension(asset.name);
    final originalFileName = p.setExtension(fileName, extension);

    final String metadata = UploadTaskMetadata(
      localAssetId: asset.id,
      isLivePhotos: entity.isLivePhoto,
      livePhotoVideoId: '',
      checksum: asset.checksum,
    ).toJson();

    final requiresWiFi = _shouldRequireWiFi(asset);

    return buildUploadTask(
      file,
      createdAt: asset.createdAt,
      modifiedAt: asset.updatedAt,
      originalFileName: originalFileName,
      deviceAssetId: asset.id,
      metadata: metadata,
      group: group,
      priority: priority,
      isFavorite: asset.isFavorite,
      requiresWiFi: requiresWiFi,
      // Visibility hidden on upload to prevent the server from running regular jobs on the live photo asset
      fields: entity.isLivePhoto ? {'visibility': api.AssetVisibility.hidden.toString()} : null,
      cloudId: entity.isLivePhoto ? null : asset.cloudId,
      adjustmentTime: entity.isLivePhoto ? null : asset.adjustmentTime?.toIso8601String(),
      latitude: entity.isLivePhoto ? null : asset.latitude?.toString(),
      longitude: entity.isLivePhoto ? null : asset.longitude?.toString(),
    );
  }

  @visibleForTesting
  Future<UploadTask?> getLivePhotoUploadTask(LocalAsset asset, String livePhotoVideoId) async {
    final entity = await _storageRepository.getAssetEntityForAsset(asset);
    if (entity == null) {
      return null;
    }

    final file = await _storageRepository.getFileForAsset(asset.id);
    if (file == null) {
      return null;
    }

    final fields = {'livePhotoVideoId': livePhotoVideoId};

    final requiresWiFi = _shouldRequireWiFi(asset);
    final originalFileName = await _assetMediaRepository.getOriginalFilename(asset.id) ?? asset.name;

    return buildUploadTask(
      file,
      createdAt: asset.createdAt,
      modifiedAt: asset.updatedAt,
      originalFileName: originalFileName,
      deviceAssetId: asset.id,
      metadata: UploadTaskMetadata(
        localAssetId: asset.id,
        isLivePhotos: false,
        livePhotoVideoId: livePhotoVideoId,
        checksum: asset.checksum,
      ).toJson(),
      fields: fields,
      group: kBackupLivePhotoGroup,
      priority: 0, // Highest priority to get upload immediately
      isFavorite: asset.isFavorite,
      requiresWiFi: requiresWiFi,
      cloudId: asset.cloudId,
      adjustmentTime: asset.adjustmentTime?.toIso8601String(),
      latitude: asset.latitude?.toString(),
      longitude: asset.longitude?.toString(),
    );
  }

  bool _shouldRequireWiFi(LocalAsset asset) {
    final backup = SettingsRepository.instance.appConfig.backup;
    if (asset.isVideo && backup.useCellularForVideos) {
      return false;
    }
    if (!asset.isVideo && backup.useCellularForPhotos) {
      return false;
    }
    return true;
  }

  Future<UploadTask> buildUploadTask(
    File file, {
    required String group,
    required DateTime createdAt,
    required DateTime modifiedAt,
    Map<String, String>? fields,
    String? originalFileName,
    String? deviceAssetId,
    String? metadata,
    int? priority,
    bool? isFavorite,
    bool requiresWiFi = true,
    String? cloudId,
    String? adjustmentTime,
    String? latitude,
    String? longitude,
  }) async {
    final serverEndpoint = Store.get(StoreKey.serverEndpoint);
    final url = Uri.parse('$serverEndpoint/assets').toString();
    final headers = ApiService.getRequestHeaders();
    final deviceId = Store.get(StoreKey.deviceId);
    final (baseDirectory, directory, filename) = await Task.split(filePath: file.path);
    final fieldsMap = {
      'filename': originalFileName ?? filename,
      // deviceAssetId/deviceId required by server v2.7.5 and below (drop in v4.0 per #27818).
      'deviceAssetId': deviceAssetId ?? '',
      'deviceId': deviceId,
      'fileCreatedAt': createdAt.toUtc().toIso8601String(),
      'fileModifiedAt': modifiedAt.toUtc().toIso8601String(),
      'isFavorite': isFavorite?.toString() ?? 'false',
      'duration': '0',
      ...?fields,
      if (CurrentPlatform.isIOS && cloudId != null)
        'metadata': jsonEncode([
          RemoteAssetMetadataItem(
            key: RemoteAssetMetadataKey.mobileApp,
            value: RemoteAssetMobileAppMetadata(
              cloudId: cloudId,
              createdAt: createdAt.toIso8601String(),
              adjustmentTime: adjustmentTime,
              latitude: latitude,
              longitude: longitude,
            ),
          ),
        ]),
    };

    return UploadTask(
      taskId: deviceAssetId,
      displayName: originalFileName ?? filename,
      httpRequestMethod: 'POST',
      url: url,
      headers: headers,
      filename: filename,
      fields: fieldsMap,
      baseDirectory: baseDirectory,
      directory: directory,
      fileField: 'assetData',
      metaData: metadata ?? '',
      group: group,
      requiresWiFi: requiresWiFi,
      priority: priority ?? 5,
      updates: Updates.statusAndProgress,
      // On iOS a backup upload is sent from the copy the session made, its export is gone: what fails is queued again
      // by the next backup run, with a new export
      retries: CurrentPlatform.isIOS && (group == kBackupGroup || group == kBackupLivePhotoGroup) ? 0 : 3,
    );
  }
}
