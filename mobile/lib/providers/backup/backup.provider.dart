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

/// Where an upload is at: its file being exported from the photo library, waiting its turn in the background session,
/// or uploading
enum UploadPhase { preparing, waiting, uploading }

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
    @Default(UploadPhase.uploading) UploadPhase phase,
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

  /// Assets the background session uploaded, not to be queued again before the server sync knows them
  final Set<String> _uploadedInSession = {};

  /// Assets whose file is being exported for the background session
  final Set<String> _preparing = {};

  /// How long the app keeps queuing uploads for the background session once it left the screen (iOS gives about 30s)
  @visibleForTesting
  static Duration handOffTime = const Duration(seconds: 20);

  /// How often the queue of the background session is looked at, besides each time one of its uploads ends
  @visibleForTesting
  static Duration sessionPollInterval = const Duration(seconds: 5);

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
    // it stops before its next export now that the app is back
    final handOff = _handOff;
    if (handOff != null) {
      await handOff.catchError((_) {});
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
    final run = _isIOS
        ? _runSessionBackup(userId, cancelToken, isCurrent)
        : _foregroundUploadService.uploadCandidates(
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

  /// The uploads already given to the background session carry on once the app left the screen. In the time iOS gives
  /// before suspending the app, it tops up their queue
  Future<void> handOffToBackground(String userId) {
    stopForegroundBackup(reason: "the app being sent to the background");
    final handOff = BackgroundTime.run(() async {
      final previous = _run;
      if (previous != null) {
        await previous.catchError((_) {});
      }
      bool isBack() => _cancelToken != null || !mounted;
      if (isBack()) {
        return;
      }
      final queued = await _backgroundUploadService.uploadBackupCandidates(
        userId,
        deadline: DateTime.now().add(handOffTime),
        shouldStop: isBack,
        skip: _uploadedInSession,
        onWifi: await _foregroundUploadService.isOnWifi().catchError((_) => true),
      );
      _logger.info("Handed $queued more uploads over to the background");
    });
    _handOff = handOff;
    return handOff.whenComplete(() {
      if (identical(_handOff, handOff)) {
        _handOff = null;
      }
    });
  }

  /// On iOS the backup is uploaded by the background session, which carries on while the app is suspended. The app
  /// keeps it uploads ahead, as many as the room set for their files allows (exporting them from the photo library
  /// takes the app), and shows how they go
  Future<void> _runSessionBackup(String userId, Completer<void> cancelToken, bool Function() isCurrent) async {
    final failed = <String>{};
    var completed = 0;
    var news = Completer<void>();
    void wake() {
      if (!news.isCompleted) {
        news.complete();
      }
    }

    final subscriptions = [
      _backgroundUploadService.taskProgressStream.listen((update) {
        if (BackgroundUploadService.isBackupTask(update.task) &&
            isCurrent() &&
            update.progress >= 0 &&
            update.progress <= 1) {
          _handleBackgroundProgress(update);
        }
      }),
      _backgroundUploadService.taskStatusStream.listen((update) {
        if (!BackgroundUploadService.isBackupTask(update.task)) {
          return;
        }
        final id = update.task.taskId;
        switch (update.status) {
          case TaskStatus.complete:
            _uploadedInSession.add(id);
            // the still of a live photo follows its video
            if (!_isLivePhotoVideo(update.task)) {
              completed++;
              if (isCurrent()) {
                _handleForegroundBackupSuccess(id, '');
              }
            }
            wake();
          case TaskStatus.failed || TaskStatus.notFound:
            _uploadedInSession.remove(id);
            failed.add(id);
            if (isCurrent()) {
              _handleForegroundBackupError(
                id,
                update.exception?.description ?? update.status.name,
                filename: update.task.displayName,
              );
            }
            wake();
          case TaskStatus.canceled:
            if (isCurrent()) {
              _uploadSpeedManager.removeTask(id);
              _removeUploadItem(id);
            }
            wake();
          default:
            break;
        }
      }),
    ];

    try {
      // what the session took on while the app was away
      if (isCurrent()) {
        _showQueue(await _backgroundUploadService.getActiveBackupTasks());
      }
      while (!cancelToken.isCompleted) {
        news = Completer<void>();
        await _backgroundUploadService.uploadBackupCandidates(
          userId,
          shouldStop: () => cancelToken.isCompleted,
          skip: {..._uploadedInSession, ...failed},
          onWifi: await _foregroundUploadService.isOnWifi().catchError((_) => true),
          onPreparing: (asset) {
            if (isCurrent()) {
              _showPreparing(asset);
            }
          },
          onICloudProgress: (asset, progress) {
            if (isCurrent()) {
              _handleICloudProgress(asset.id, progress);
            }
          },
          onPrepared: (asset, queued) {
            _preparing.remove(asset.id);
            if (!isCurrent()) {
              return;
            }
            final item = state.uploadItems[asset.id];
            if (!queued) {
              _removeUploadItem(asset.id);
            } else if (item != null && item.phase == UploadPhase.preparing) {
              _setUploadItem(item.copyWith(phase: UploadPhase.waiting));
            }
          },
        );
        if (cancelToken.isCompleted) {
          break;
        }
        final tasks = await _backgroundUploadService.getActiveBackupTasks();
        if (isCurrent()) {
          _showQueue(tasks);
        }
        if (tasks.isEmpty) {
          break;
        }
        await Future.any([news.future, cancelToken.future, Future<void>.delayed(sessionPollInterval)]);
      }
    } finally {
      for (final subscription in subscriptions) {
        unawaited(subscription.cancel());
      }
      _preparing.clear();
    }

    // the assets uploaded are only known as backed up once the server says so
    if (completed > 0 && !cancelToken.isCompleted) {
      if (await _syncRemote?.call().catchError((_) => false) ?? false) {
        _uploadedInSession.clear();
      }
      if (!cancelToken.isCompleted) {
        await getBackupStatus(userId);
      }
    }
  }

  void _setUploadItem(UploadStatus item) {
    state = state.copyWith(uploadItems: {...state.uploadItems, item.taskId: item});
  }

  /// Lists the uploads in the session, the ones not moving yet as waiting, and drops those it is done with
  void _showQueue(List<Task> tasks) {
    final inSession = {for (final task in tasks) task.taskId: task};
    final items = <String, UploadStatus>{
      for (final item in state.uploadItems.values)
        if (item.isFailed == true ||
            item.phase == UploadPhase.preparing ||
            inSession.containsKey(item.taskId) ||
            item.progress >= 1)
          item.taskId: item,
    };
    for (final task in tasks) {
      items.putIfAbsent(
        task.taskId,
        () => UploadStatus(
          taskId: task.taskId,
          filename: task.displayName,
          progress: 0,
          fileSize: 0,
          networkSpeedAsString: '',
          phase: UploadPhase.waiting,
        ),
      );
    }
    if (!mapEquals(items, state.uploadItems)) {
      state = state.copyWith(uploadItems: items);
    }
  }

  static bool _isLivePhotoVideo(Task task) {
    try {
      return task.metaData.isNotEmpty && UploadTaskMetadata.fromJson(task.metaData).isLivePhotos;
    } catch (_) {
      return false;
    }
  }

  void _showPreparing(LocalAsset asset) {
    _preparing.add(asset.id);
    _setUploadItem(
      UploadStatus(
        taskId: asset.id,
        filename: asset.name,
        progress: 0,
        fileSize: 0,
        networkSpeedAsString: '',
        phase: UploadPhase.preparing,
      ),
    );
  }

  void _handleBackgroundProgress(TaskProgressUpdate update) {
    final id = update.task.taskId;
    final current = state.uploadItems[id];
    final fileSize = update.hasExpectedFileSize ? update.expectedFileSize : (current?.fileSize ?? 0);
    // a task the system has not started yet tells it is at 0
    final phase = update.progress > 0 ? UploadPhase.uploading : (current?.phase ?? UploadPhase.waiting);
    _setUploadItem(
      UploadStatus(
        taskId: id,
        filename: update.task.displayName,
        progress: update.progress,
        fileSize: fileSize,
        networkSpeedAsString: update.hasNetworkSpeed
            ? update.networkSpeedAsString
            : (current?.networkSpeedAsString ?? ''),
        phase: phase == UploadPhase.preparing ? UploadPhase.waiting : phase,
      ),
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

  void _handleForegroundBackupError(String localAssetId, String errorMessage, {String filename = 'Unknown'}) {
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
            filename: filename,
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

    if (tasks.isNotEmpty) {
      _logger.info("Resuming upload ${tasks.length} assets");
      await _backgroundUploadService.resume();
    }

    if (!await remoteSync) {
      _logger.warning("Remote sync did not complete successfully, skipping new upload");
      return;
    }
    // up to the same few uploads ahead as in the app
    await _backgroundUploadService.uploadBackupCandidates(userId);
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
