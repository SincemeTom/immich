import 'dart:async';

import 'package:background_downloader/background_downloader.dart';
import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/platform/background_time.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/utils/upload_speed_calculator.dart';
import 'package:logging/logging.dart';

part 'backup.provider.freezed.dart';

@freezed
abstract class UploadStatus with _$UploadStatus {
  const factory UploadStatus({
    required String taskId,
    required String filename,
    required double progress,
    required int fileSize,
    required String networkSpeedAsString,
    bool? isFailed,
    String? error,
  }) = _UploadStatus;
}

enum BackupError { none, syncFailed }

@freezed
abstract class BackupState with _$BackupState {
  const BackupState._();

  const factory BackupState({
    required int totalCount,
    required int backupCount,
    required int remainderCount,
    required int processingCount,
    required bool isSyncing,
    @Default(BackupError.none) BackupError error,
    required Map<String, UploadStatus> uploadItems,
    @Default({}) Map<String, double> iCloudDownloadProgress,
  }) = _BackupState;

  int get errorCount => uploadItems.values.where((item) => item.isFailed == true).length;
}

final StateNotifierProvider<BackupNotifier, BackupState> backupProvider =
    StateNotifierProvider<BackupNotifier, BackupState>((ref) {
      return BackupNotifier(
        ref.watch(foregroundUploadServiceProvider),
        ref.watch(backgroundUploadServiceProvider),
        UploadSpeedManager(),
        syncRemote: () => ref.read(backgroundSyncProvider).syncRemote(),
      );
    });

class BackupNotifier extends StateNotifier<BackupState> {
  BackupNotifier(
    this._foregroundUploadService,
    this._backgroundUploadService,
    this._uploadSpeedManager, {
    this._syncRemote,
    bool? isIOS,
  }) : _isIOS = isIOS ?? CurrentPlatform.isIOS,
       super(
         const BackupState(
           totalCount: 0,
           backupCount: 0,
           remainderCount: 0,
           processingCount: 0,
           isSyncing: false,
           uploadItems: {},
           error: BackupError.none,
         ),
       );

  final ForegroundUploadService _foregroundUploadService;
  final BackgroundUploadService _backgroundUploadService;
  final UploadSpeedManager _uploadSpeedManager;
  Completer<void>? _cancelToken;

  /// The upload run going on, cancelled or not
  Future<void>? _run;

  /// The backup being handed to the background session as the app leaves
  Future<void>? _handOff;

  final Future<bool> Function()? _syncRemote;
  final bool _isIOS;

  /// How long the app keeps queuing uploads for the background session once it left the screen (iOS gives about 30s)
  @visibleForTesting
  static Duration handOffTime = const Duration(seconds: 20);

  /// How long the uploads in the background session may go without news before the app takes them over (they send
  /// some at least every 2.5 seconds while they move; a Wi-Fi only upload on mobile data never starts)
  @visibleForTesting
  static Duration backgroundStallTime = const Duration(seconds: 60);

  @visibleForTesting
  static Duration backgroundPollInterval = const Duration(seconds: 2);

  final _logger = Logger("BackupNotifier");

  /// Remove upload item from state
  void _removeUploadItem(String taskId) {
    if (!mounted) {
      _logger.warning("Skip _removeUploadItem: notifier disposed");
      return;
    }
    if (state.uploadItems.containsKey(taskId)) {
      final updatedItems = Map<String, UploadStatus>.from(state.uploadItems);
      updatedItems.remove(taskId);
      state = state.copyWith(uploadItems: updatedItems);
    }
  }

  Future<void> getBackupStatus(String userId) async {
    if (!mounted) {
      _logger.warning("Skip getBackupStatus (pre-call): notifier disposed");
      return;
    }
    final counts = await _foregroundUploadService.getBackupCounts(userId);
    if (!mounted) {
      _logger.warning("Skip getBackupStatus (post-call): notifier disposed");
      return;
    }

    state = state.copyWith(
      totalCount: counts.total,
      backupCount: counts.total - counts.remainder,
      remainderCount: counts.remainder,
      processingCount: counts.processing,
    );
  }

  void updateError(BackupError error) {
    if (!mounted) {
      _logger.warning("Skip updateError: notifier disposed");
      return;
    }
    state = state.copyWith(error: error);
  }

  void updateSyncing(bool isSyncing) {
    state = state.copyWith(isSyncing: isSyncing);
  }

  Future<void> startForegroundBackup(String userId) async {
    // Cancel any existing backup before starting a new one
    if (_cancelToken != null) {
      stopForegroundBackup(reason: "restarting the backup");
    }

    state = state.copyWith(error: BackupError.none);

    // A pause during the recount below nulls _cancelToken, so the run keeps its own reference.
    final cancelToken = Completer<void>();
    _cancelToken = cancelToken;

    // The cancelled run still finishes the file it was preparing: running alongside it would upload the same assets
    // from the same temporary files, which each run deletes when done with them (and clears when it starts)
    final previous = _run;
    if (previous != null) {
      await previous.catchError((_) {});
    }
    final handOff = _handOff;
    if (handOff != null) {
      _backgroundUploadService.shouldAbortQueuingTasks = true;
      await handOff.catchError((_) {});
    }
    if (cancelToken.isCompleted) {
      return;
    }

    // What went on in the background session while the app was away carries on there, rather than starting over
    if (_isIOS && await _followBackgroundUploads(userId, cancelToken)) {
      if (cancelToken.isCompleted) {
        return;
      }
      // the assets uploaded there are only known as backed up once the server says so
      await _syncRemote?.call().catchError((_) => false);
    }
    if (cancelToken.isCompleted) {
      return;
    }

    // Re-baseline the counters against the same DB read that feeds this run's candidate list,
    // otherwise a resume counts duplicate successes against the old baseline (#26215).
    await getBackupStatus(userId);
    if (cancelToken.isCompleted) {
      return;
    }

    // What a cancelled run still reports would come back as uploads that never move or end
    bool isCurrent() => mounted && identical(_cancelToken, cancelToken);
    final run = _foregroundUploadService.uploadCandidates(
      userId,
      cancelToken,
      callbacks: UploadCallbacks(
        onProgress: (id, filename, bytes, totalBytes) {
          if (isCurrent()) {
            _handleForegroundBackupProgress(id, filename, bytes, totalBytes);
          }
        },
        onSuccess: (localId, remoteId) {
          if (isCurrent()) {
            _handleForegroundBackupSuccess(localId, remoteId);
          }
        },
        onError: (id, errorMessage) {
          if (isCurrent()) {
            _handleForegroundBackupError(id, errorMessage);
          } else {
            _logger.warning("Upload of $id failed after its backup run was cancelled: $errorMessage");
          }
        },
        onICloudProgress: (id, progress) {
          if (isCurrent()) {
            _handleICloudProgress(id, progress);
          }
        },
      ),
    );
    _run = run;
    try {
      await run;
    } finally {
      if (identical(_run, run)) {
        _run = null;
      }
    }
  }

  /// iOS suspends the app soon after it leaves the screen, which stops its uploads: what is left goes on in the
  /// background session, as much as can be prepared in the time iOS gives
  Future<void> handOffToBackground(String userId) {
    stopForegroundBackup(reason: "the app being sent to the background");
    final handOff = BackgroundTime.run(() async {
      final previous = _run;
      if (previous != null) {
        await previous.catchError((_) {});
      }
      // back on screen meanwhile
      if (_cancelToken != null || !mounted) {
        return;
      }
      final queued = await _backgroundUploadService.uploadBackupCandidates(
        userId,
        deadline: DateTime.now().add(handOffTime),
      );
      _logger.info("Handed $queued uploads over to the background");
    });
    _handOff = handOff;
    return handOff.whenComplete(() {
      if (identical(_handOff, handOff)) {
        _handOff = null;
      }
    });
  }

  /// Shows the uploads going on in the background session until they are over
  ///
  /// Returns whether any of them completed
  Future<bool> _followBackgroundUploads(String userId, Completer<void> cancelToken) async {
    var tasks = await _backgroundUploadService.getActiveBackupTasks();
    if (tasks.isEmpty || cancelToken.isCompleted) {
      return false;
    }
    _logger.info("Following ${tasks.length} uploads going on in the background");
    await getBackupStatus(userId);

    bool isCurrent() => mounted && identical(_cancelToken, cancelToken);
    var lastNews = DateTime.now();
    var completed = false;
    final subscriptions = [
      _backgroundUploadService.taskProgressStream.listen((update) {
        if (!BackgroundUploadService.isBackupTask(update.task)) {
          return;
        }
        lastNews = DateTime.now();
        if (isCurrent() && update.progress >= 0 && update.progress <= 1) {
          _handleBackgroundProgress(update);
        }
      }),
      _backgroundUploadService.taskStatusStream.listen((update) {
        if (!BackgroundUploadService.isBackupTask(update.task)) {
          return;
        }
        lastNews = DateTime.now();
        if (!isCurrent()) {
          return;
        }
        final id = update.task.taskId;
        switch (update.status) {
          case TaskStatus.complete:
            completed = true;
            _uploadSpeedManager.removeTask(id);
            Future.delayed(const Duration(milliseconds: 1000), () => _removeUploadItem(id));
          case TaskStatus.failed || TaskStatus.notFound:
            _handleForegroundBackupError(id, update.exception?.description ?? update.status.name);
          case TaskStatus.canceled:
            _uploadSpeedManager.removeTask(id);
            _removeUploadItem(id);
          default:
            break;
        }
      }),
    ];

    try {
      while (true) {
        await Future.any([cancelToken.future, Future<void>.delayed(backgroundPollInterval)]);
        if (cancelToken.isCompleted) {
          break;
        }
        tasks = await _backgroundUploadService.getActiveBackupTasks();
        if (tasks.isEmpty || cancelToken.isCompleted) {
          break;
        }
        if (DateTime.now().difference(lastNews) > backgroundStallTime) {
          _logger.warning("The ${tasks.length} uploads in the background are not moving, the app takes them over");
          await _backgroundUploadService.cancelTasks(tasks.map((task) => task.taskId));
          break;
        }
      }
    } finally {
      for (final subscription in subscriptions) {
        unawaited(subscription.cancel());
      }
    }
    return completed;
  }

  void _handleBackgroundProgress(TaskProgressUpdate update) {
    final id = update.task.taskId;
    final fileSize = update.hasExpectedFileSize ? update.expectedFileSize : (state.uploadItems[id]?.fileSize ?? 0);
    state = state.copyWith(
      uploadItems: {
        ...state.uploadItems,
        id: UploadStatus(
          taskId: id,
          filename: update.task.displayName,
          progress: update.progress,
          fileSize: fileSize,
          networkSpeedAsString: update.hasNetworkSpeed
              ? update.networkSpeedAsString
              : (state.uploadItems[id]?.networkSpeedAsString ?? ''),
        ),
      },
    );
  }

  /// Stops the backup, in the app and in the background session
  Future<void> stopBackup({required String reason}) async {
    stopForegroundBackup(reason: reason);
    if (_isIOS) {
      await _backgroundUploadService.cancel();
    }
  }

  void stopForegroundBackup({required String reason}) {
    if (_cancelToken != null) {
      _logger.info("Foreground backup cancelled: $reason");
    }
    _cancelToken?.complete();
    _cancelToken = null;
    _uploadSpeedManager.clear();
    state = state.copyWith(uploadItems: {}, iCloudDownloadProgress: {});
  }

  void _handleICloudProgress(String localAssetId, double progress) {
    state = state.copyWith(iCloudDownloadProgress: {...state.iCloudDownloadProgress, localAssetId: progress});

    if (progress >= 1.0) {
      Future.delayed(const Duration(milliseconds: 250), () {
        final updatedProgress = Map<String, double>.from(state.iCloudDownloadProgress);
        updatedProgress.remove(localAssetId);
        state = state.copyWith(iCloudDownloadProgress: updatedProgress);
      });
    }
  }

  void _handleForegroundBackupProgress(String localAssetId, String filename, int bytes, int totalBytes) {
    if (_cancelToken == null) {
      return;
    }

    final progress = totalBytes > 0 ? bytes / totalBytes : 0.0;
    final networkSpeedAsString = _uploadSpeedManager.updateProgress(localAssetId, bytes, totalBytes);
    final currentItem = state.uploadItems[localAssetId];
    if (currentItem != null) {
      state = state.copyWith(
        uploadItems: {
          ...state.uploadItems,
          localAssetId: currentItem.copyWith(
            filename: filename,
            progress: progress,
            fileSize: totalBytes,
            networkSpeedAsString: networkSpeedAsString,
            // tried again after failing in the background
            isFailed: null,
            error: null,
          ),
        },
      );
    } else {
      state = state.copyWith(
        uploadItems: {
          ...state.uploadItems,
          localAssetId: UploadStatus(
            taskId: localAssetId,
            filename: filename,
            progress: progress,
            fileSize: totalBytes,
            networkSpeedAsString: networkSpeedAsString,
          ),
        },
      );
    }
  }

  void _handleForegroundBackupSuccess(String localAssetId, String remoteAssetId) {
    if (!mounted) {
      _logger.warning("Skip _handleForegroundBackupSuccess: notifier disposed");
      return;
    }
    state = state.copyWith(backupCount: state.backupCount + 1, remainderCount: state.remainderCount - 1);
    _uploadSpeedManager.removeTask(localAssetId);

    Future.delayed(const Duration(milliseconds: 1000), () {
      _removeUploadItem(localAssetId);
    });
  }

  void _handleForegroundBackupError(String localAssetId, String errorMessage) {
    _logger.severe("Upload failed for $localAssetId: $errorMessage");

    final currentItem = state.uploadItems[localAssetId];
    if (currentItem != null) {
      state = state.copyWith(
        uploadItems: {
          ...state.uploadItems,
          localAssetId: currentItem.copyWith(isFailed: true, error: errorMessage),
        },
      );
    } else {
      state = state.copyWith(
        uploadItems: {
          ...state.uploadItems,
          localAssetId: UploadStatus(
            taskId: localAssetId,
            filename: 'Unknown',
            progress: 0,
            fileSize: 0,
            networkSpeedAsString: '',
            isFailed: true,
            error: errorMessage,
          ),
        },
      );
    }

    _uploadSpeedManager.removeTask(localAssetId);
  }

  Future<void> startBackupWithURLSession(String userId, Future<bool> remoteSync) async {
    if (!mounted) {
      _logger.warning("Skip handleBackupResume (pre-call): notifier disposed");
      return;
    }
    _logger.info("Start background backup sequence");
    state = state.copyWith(error: BackupError.none);
    final tasks = await _backgroundUploadService.getActiveTasks(kBackupGroup);
    if (!mounted) {
      _logger.warning("Skip handleBackupResume (post-call): notifier disposed");
      return;
    }
    _logger.info("Found ${tasks.length} pending tasks");

    if (tasks.isEmpty) {
      if (!await remoteSync) {
        _logger.warning("Remote sync did not complete successfully, skipping new upload");
        return;
      }
      _logger.info("No pending tasks, starting new upload");
      await _backgroundUploadService.uploadBackupCandidates(userId);
      return;
    }

    _logger.info("Resuming upload ${tasks.length} assets");
    return _backgroundUploadService.resume();
  }
}

final backupCandidateProvider = FutureProvider.autoDispose<List<LocalAsset>>((ref) {
  final user = ref.watch(currentUserProvider);
  if (user == null) {
    return [];
  }

  return ref.read(foregroundUploadServiceProvider).getBackupCandidates(user.id, onlyHashed: false);
});

final candidateBackupAlbumInfoProvider = FutureProvider.autoDispose.family<List<LocalAlbum>, String>((ref, assetId) {
  return ref
      .read(driftProvider)
      .localAssetRepository
      .getSourceAlbums(assetId, backupSelection: BackupSelection.selected);
});
