import 'dart:async';

import 'package:background_downloader/background_downloader.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/providers/backup/backup.provider.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/utils/upload_speed_calculator.dart';
import 'package:mocktail/mocktail.dart';

class MockForegroundUploadService extends Mock implements ForegroundUploadService {}

class MockBackgroundUploadService extends Mock implements BackgroundUploadService {}

void main() {
  late MockForegroundUploadService foregroundUploadService;
  late MockBackgroundUploadService backgroundUploadService;
  late BackupNotifier notifier;

  setUpAll(() {
    registerFallbackValue(Completer<void>());
    registerFallbackValue(const UploadCallbacks());
  });

  setUp(() {
    foregroundUploadService = MockForegroundUploadService();
    backgroundUploadService = MockBackgroundUploadService();
    notifier = BackupNotifier(foregroundUploadService, backgroundUploadService, UploadSpeedManager());
    addTearDown(() {
      if (notifier.mounted) {
        notifier.dispose();
      }
    });
  });

  void mockCounts({required int total, required int remainder, int processing = 0}) {
    when(
      () => foregroundUploadService.getBackupCounts('user-1'),
    ).thenAnswer((_) async => (total: total, remainder: remainder, processing: processing));
  }

  // Drives a backup run so we can grab the onSuccess callback the notifier wires up.
  Future<void Function(String, String)> startAndCaptureOnSuccess() async {
    void Function(String, String)? onSuccess;
    when(() => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks'))).thenAnswer((
      invocation,
    ) async {
      onSuccess = (invocation.namedArguments[#callbacks] as UploadCallbacks).onSuccess;
    });
    await notifier.startForegroundBackup('user-1');
    return onSuccess!;
  }

  group('foreground backup counts', () {
    test('successes move one asset from remainder to backup', () async {
      mockCounts(total: 25, remainder: 25);
      final onSuccess = await startAndCaptureOnSuccess();

      for (var i = 0; i < 10; i++) {
        onSuccess('asset-$i', 'remote-$i');
      }

      expect(notifier.state.remainderCount, 15);
      expect(notifier.state.backupCount, 10);
      expect(notifier.state.backupCount + notifier.state.remainderCount, notifier.state.totalCount);
    });

    test('a duplicate success after pause and resume cannot go below zero', () async {
      // #26215: app pauses mid-backup, sync has not recorded the upload yet, so the
      // resumed run re-uploads the same asset and the server answers 200 duplicate.
      // The start of each run re-baselines the counters from the DB, so the duplicate
      // success is counted against a baseline that includes the asset again.
      mockCounts(total: 1, remainder: 1);

      final firstRun = await startAndCaptureOnSuccess();
      expect(notifier.state.remainderCount, 1);
      firstRun('asset-1', 'remote-1');
      expect(notifier.state.remainderCount, 0);

      notifier.stopForegroundBackup(reason: "test");

      final resumedRun = await startAndCaptureOnSuccess();
      expect(notifier.state.remainderCount, 1);
      verify(() => foregroundUploadService.getBackupCounts('user-1')).called(2);

      resumedRun('asset-1', 'remote-1');
      expect(notifier.state.remainderCount, 0);
      expect(notifier.state.backupCount, 1);
    });

    test('a drifted counter state heals at run start', () async {
      mockCounts(total: 91, remainder: 7);
      notifier.state = notifier.state.copyWith(totalCount: 91, backupCount: 103, remainderCount: -12);

      await startAndCaptureOnSuccess();

      expect(notifier.state.totalCount, 91);
      expect(notifier.state.remainderCount, 7);
      expect(notifier.state.backupCount, 84);
    });

    test('a late success after dispose does not throw', () async {
      mockCounts(total: 2, remainder: 2);
      final onSuccess = await startAndCaptureOnSuccess();
      notifier.dispose();

      onSuccess('asset-1', 'remote-1');
    });
  });

  group('restarting the backup', () {
    late List<UploadCallbacks> runs;
    late List<Completer<void>> runsDone;

    setUp(() {
      mockCounts(total: 5, remainder: 5);
      runs = [];
      runsDone = [];
      when(() => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks'))).thenAnswer(
        (invocation) {
          runs.add(invocation.namedArguments[#callbacks] as UploadCallbacks);
          final done = Completer<void>();
          runsDone.add(done);
          return done.future;
        },
      );
    });

    test('waits for the cancelled run before uploading again', () async {
      unawaited(notifier.startForegroundBackup('user-1'));
      await pumpEventQueue();
      expect(runs, hasLength(1));

      final restarted = notifier.startForegroundBackup('user-1');
      await pumpEventQueue();
      expect(runs, hasLength(1));

      runsDone[0].complete();
      await pumpEventQueue();
      expect(runs, hasLength(2));

      runsDone[1].complete();
      await restarted;
    });

    test('only the last of restarts in a row uploads', () async {
      unawaited(notifier.startForegroundBackup('user-1'));
      await pumpEventQueue();
      final second = notifier.startForegroundBackup('user-1');
      final third = notifier.startForegroundBackup('user-1');
      await pumpEventQueue();

      runsDone[0].complete();
      await second;
      await pumpEventQueue();
      expect(runs, hasLength(2));

      runsDone[1].complete();
      await third;
    });

    test('what a cancelled run still reports does not show', () async {
      unawaited(notifier.startForegroundBackup('user-1'));
      await pumpEventQueue();
      final cancelled = runs[0];
      cancelled.onProgress!('asset-1', 'a.mp4', 10, 100);
      expect(notifier.state.uploadItems.keys, ['asset-1']);

      notifier.stopForegroundBackup(reason: 'test');
      unawaited(notifier.startForegroundBackup('user-1'));
      await pumpEventQueue();

      cancelled.onProgress!('asset-1', 'a.mp4', 20, 100);
      cancelled.onError!('asset-2', 'PathNotFoundException');
      cancelled.onSuccess!('asset-3', 'remote-3');
      cancelled.onICloudProgress!('asset-4', 0.5);
      expect(notifier.state.uploadItems, isEmpty);
      expect(notifier.state.iCloudDownloadProgress, isEmpty);

      runsDone[0].complete();
      await pumpEventQueue();
      expect(notifier.state.backupCount, 0);
      runs[1].onProgress!('asset-1', 'a.mp4', 30, 100);
      expect(notifier.state.uploadItems['asset-1']!.progress, 0.3);
      runsDone[1].complete();
    });
  });

  group('iOS background session', () {
    late StreamController<TaskProgressUpdate> progress;
    late StreamController<TaskStatusUpdate> status;
    late List<Task> activeTasks;
    late int remoteSyncs;
    late int foregroundRuns;

    UploadTask task(String id) => UploadTask(
      taskId: id,
      url: 'https://example.com/assets',
      filename: '$id.mp4',
      displayName: '$id.mp4',
      group: kBackupGroup,
    );

    setUp(() {
      BackupNotifier.backgroundPollInterval = const Duration(milliseconds: 10);
      BackupNotifier.backgroundStallTime = const Duration(seconds: 60);
      progress = StreamController.broadcast();
      status = StreamController.broadcast();
      activeTasks = [];
      remoteSyncs = 0;
      foregroundRuns = 0;
      notifier.dispose();
      notifier = BackupNotifier(
        foregroundUploadService,
        backgroundUploadService,
        UploadSpeedManager(),
        syncRemote: () async {
          remoteSyncs++;
          return true;
        },
        isIOS: true,
      );
      mockCounts(total: 5, remainder: 5);
      when(() => backgroundUploadService.taskProgressStream).thenAnswer((_) => progress.stream);
      when(() => backgroundUploadService.taskStatusStream).thenAnswer((_) => status.stream);
      when(() => backgroundUploadService.getActiveBackupTasks()).thenAnswer((_) async => List.of(activeTasks));
      when(() => backgroundUploadService.cancelTasks(any())).thenAnswer((_) async {});
      when(
        () => backgroundUploadService.uploadBackupCandidates(any(), deadline: any(named: 'deadline')),
      ).thenAnswer((_) async => 2);
      when(() => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks'))).thenAnswer(
        (_) async {
          foregroundRuns++;
        },
      );
    });

    tearDown(() {
      unawaited(progress.close());
      unawaited(status.close());
    });

    test('leaving the app hands what is left over to the background', () async {
      unawaited(notifier.startForegroundBackup('user-1'));
      await pumpEventQueue();

      await notifier.handOffToBackground('user-1');

      verify(
        () => backgroundUploadService.uploadBackupCandidates('user-1', deadline: any(named: 'deadline')),
      ).called(1);
      expect(notifier.state.uploadItems, isEmpty);
    });

    test('coming back follows the background uploads, then backs up the rest in the app', () async {
      activeTasks = [task('asset-1')];
      final started = notifier.startForegroundBackup('user-1');
      await pumpEventQueue();

      progress.add(TaskProgressUpdate(task('asset-1'), 0.4, 1000, 2.5));
      await pumpEventQueue();
      final item = notifier.state.uploadItems['asset-1']!;
      expect(item.progress, 0.4);
      expect(item.fileSize, 1000);
      expect(item.networkSpeedAsString, isNot('-- MB/s'));
      expect(foregroundRuns, 0);

      status.add(TaskStatusUpdate(task('asset-1'), TaskStatus.complete));
      activeTasks = [];
      await started;

      expect(remoteSyncs, 1);
      expect(foregroundRuns, 1);
    });

    test('a background upload that failed shows as failed', () async {
      activeTasks = [task('asset-1')];
      final started = notifier.startForegroundBackup('user-1');
      await pumpEventQueue();

      status.add(TaskStatusUpdate(task('asset-1'), TaskStatus.failed, TaskException('boom')));
      await pumpEventQueue();
      expect(notifier.state.uploadItems['asset-1']!.isFailed, isTrue);

      activeTasks = [];
      await started;
      expect(remoteSyncs, 0);
      expect(foregroundRuns, 1);
    });

    test('background uploads that do not move are taken over by the app', () async {
      BackupNotifier.backgroundStallTime = Duration.zero;
      activeTasks = [task('asset-1')];

      await notifier.startForegroundBackup('user-1');

      verify(() => backgroundUploadService.cancelTasks(['asset-1'])).called(1);
      expect(foregroundRuns, 1);
    });

    test('leaving again stops following', () async {
      activeTasks = [task('asset-1')];
      final started = notifier.startForegroundBackup('user-1');
      await pumpEventQueue();

      notifier.stopForegroundBackup(reason: 'test');
      await started;

      progress.add(TaskProgressUpdate(task('asset-1'), 0.5));
      await pumpEventQueue();
      expect(notifier.state.uploadItems, isEmpty);
      expect(foregroundRuns, 0);
    });

    test('turning the backup off empties the background session', () async {
      when(() => backgroundUploadService.cancel()).thenAnswer((_) async => 0);

      await notifier.stopBackup(reason: 'test');

      verify(() => backgroundUploadService.cancel()).called(1);
    });
  });
}
