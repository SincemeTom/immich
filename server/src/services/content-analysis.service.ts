import { Injectable } from '@nestjs/common';

import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  AssetType,
  AssetVisibility,
  BootstrapEventPriority,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { compareForPrimary, isBetterCover } from 'src/utils/auto-stack.js';
import {
  BASE_TASKS,
  CONTENT_ANALYSIS_VERSION,
  COVER_MIN_GAIN,
  DOCUMENT_TAG,
  QR_CODE_TAG,
  SCREENSHOT_TAG,
  SMUDGE_TAG,
  SPEECH_TASK,
  TABLE_TAG,
  type VisionLabel,
  type VisionResult,
  type VisionTask,
  getContentTasks,
  getLabelTags,
  getTranscriptText,
  hasQrCode,
  isDocument,
  isScreenshot,
  isSmudged,
  succeeded,
} from 'src/utils/content-analysis.js';
import { tokenizeForSearch } from 'src/utils/database.js';
import { batched, isContentAnalysisEnabled } from 'src/utils/misc.js';
import { upsertTags } from 'src/utils/tag.js';

/** how long listening to one video may take: an hour of it takes a few minutes; the model's download, once, more */
const SPEECH_TIMEOUT = 30 * 60_000;

/**
 * Content analysis, on macOS: Apple's Vision framework on each asset's preview (VisionRepository), for tags in
 * Chinese under "自动" ("自动/动物/猫"), screenshots (tagged, and archived if the settings say so), QR codes, and an
 * aesthetics score, which picks the cover of an automatic stack. On macOS 26 also documents, a smudged lens, and what
 * is said in a video, which searching by text finds; on an earlier macOS these are left out, and done once the Mac
 * has macOS 26. macos/verification/m4-vision-research.md is what it is based on.
 */
@Injectable()
export class ContentAnalysisService extends BaseService {
  /**
   * After the config is initialized (it reads it), and without holding up the rest of the start: the job workers are
   * running by then, and what holds up the bootstrap before the config is set up lets them start jobs that need it
   */
  @OnEvent({
    name: 'AppBootstrap',
    priority: BootstrapEventPriority.ContentAnalysis,
    workers: [ImmichWorker.Microservices],
  })
  onBootstrap() {
    this.queueMissing().catch((error) => this.logger.warn(`Content analysis at start: ${error}`));
  }

  async queueMissing() {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isContentAnalysisEnabled(machineLearning) || !this.visionRepository.isAvailable()) {
      return;
    }
    const { macos, features } = await this.visionRepository.getCapabilities();
    const without = ['documents', 'smudge', SPEECH_TASK].filter((task) => !features.includes(task));
    this.logger.log(
      `Content analysis on macOS ${macos || '?'}: ${features.join(', ') || 'nothing'}` +
        (without.length > 0 ? `; ${without.join(', ')} need macOS 26, off` : ''),
    );
    // what is not analyzed yet, or not for all this Mac can do: the photos from before content analysis, and after
    // an upgrade to macOS 26, its requests on all of them; unless that is queued already
    const { waiting, active } = await this.jobRepository.getJobCounts(QueueName.ContentAnalysis);
    if (waiting === 0 && active === 0) {
      await this.jobRepository.queue({ name: JobName.ContentAnalysisQueueAll, data: { force: false } });
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.visionRepository.stop('shutdown');
  }

  @OnJob({ name: JobName.ContentAnalysisQueueAll, queue: QueueName.ContentAnalysis })
  async handleQueueAll({ force }: JobOf<JobName.ContentAnalysisQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isContentAnalysisEnabled(machineLearning) || !this.visionRepository.isAvailable()) {
      return JobStatus.Skipped;
    }

    // all of them again (force), or those not analyzed by this version, or not for all this Mac does now; the
    // results are kept until each is replaced, so that a screenshot archived once, and taken out of the archive,
    // stays out of it
    const { features } = await this.visionRepository.getCapabilities();
    const { speech } = machineLearning.contentAnalysis;
    const image = getContentTasks(features, { isVideo: false, speech }).image;
    const video = getContentTasks(features, { isVideo: true, speech });
    const stream = this.assetJobRepository.streamForContentAnalysis(
      CONTENT_ANALYSIS_VERSION,
      image,
      [...video.image, ...video.video],
      force,
    );
    for await (const assets of batched(stream)) {
      await this.jobRepository.queueAll(assets.map(({ id }) => ({ name: JobName.ContentAnalysis, data: { id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.ContentAnalysis, queue: QueueName.ContentAnalysis })
  async handleContentAnalysis({ id }: JobOf<JobName.ContentAnalysis>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isContentAnalysisEnabled(machineLearning) || !this.visionRepository.isAvailable()) {
      return JobStatus.Skipped;
    }
    const { contentAnalysis } = machineLearning;

    const asset = await this.assetJobRepository.getForContentAnalysis(id);
    if (!asset || !asset.previewFile) {
      return JobStatus.Failed;
    }
    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const { features } = await this.visionRepository.getCapabilities();
    const isVideo = asset.type === AssetType.Video;
    const tasks = getContentTasks(features.length > 0 ? features : [...BASE_TASKS], {
      isVideo,
      speech: contentAnalysis.speech,
    });

    const previous = await this.visionRepository.getByAssetId(id);
    const result = await this.visionRepository.analyze(asset.previewFile, tasks.image);
    if (result.error) {
      this.logger.warn(`Content analysis of ${id} failed: ${result.error}`);
      return JobStatus.Failed;
    }
    const heard =
      tasks.video.length > 0 ? await this.listen(id, asset.originalPath, contentAnalysis.speechLanguage) : {};
    const done = { ...result, ...heard };

    const labels = succeeded<VisionLabel[]>(done.classify) ?? [];
    const animals = succeeded<VisionLabel[]>(done.animals) ?? [];
    const aesthetics = succeeded(done.aesthetics);
    const barcodes = succeeded(done.barcodes) ?? [];
    const documents = succeeded(done.documents);
    const smudge = succeeded(done.smudge);
    const speech = succeeded(done.speech);
    const screenshot =
      !isVideo &&
      isScreenshot({
        originalFileName: asset.originalFileName,
        make: asset.make,
        model: asset.model,
        width: asset.exifImageWidth ?? asset.width,
        height: asset.exifImageHeight ?? asset.height,
        labels,
      });

    // the requests that succeeded now, and those of before that were not made again (a transcript is kept when
    // speech is turned off), whose results the columns left out below keep
    const attempted: VisionTask[] = [...tasks.image, ...tasks.video];
    const succeededNow = attempted.filter((task) => done[task] !== undefined && succeeded(done[task]) !== undefined);
    const kept =
      previous?.version === CONTENT_ANALYSIS_VERSION
        ? previous.features.filter((feature) => !attempted.includes(feature as VisionTask))
        : [];
    const segments = speech?.segments;

    await this.visionRepository.upsert({
      assetId: id,
      version: CONTENT_ANALYSIS_VERSION,
      features: [...new Set([...kept, ...succeededNow])],
      aestheticScore: aesthetics?.score ?? null,
      isUtility: aesthetics?.utility ?? null,
      isScreenshot: screenshot,
      labels,
      barcodes: barcodes.map(({ payload }) => payload),
      ...(documents && { isDocument: isDocument(documents, labels) }),
      ...(smudge && { smudge: smudge.confidence }),
      ...(speech && {
        // as OCR keeps its text, for the same search: words, and Chinese in pairs of characters
        transcript: tokenizeForSearch(getTranscriptText(segments)).join(' '),
        transcriptSegments: segments ?? [],
        transcriptLanguage: speech.language,
      }),
    });

    if (contentAnalysis.tags) {
      const values = getLabelTags(labels, animals);
      if (screenshot) {
        values.push(SCREENSHOT_TAG);
      }
      if (hasQrCode(barcodes)) {
        values.push(QR_CODE_TAG);
      }
      const document = documents ? isDocument(documents, labels) : !!previous?.isDocument;
      if (document) {
        values.push((documents?.tables ?? 0) > 0 ? TABLE_TAG : DOCUMENT_TAG);
      }
      if (isSmudged(smudge?.confidence ?? previous?.smudge, labels)) {
        values.push(SMUDGE_TAG);
      }
      const tags = await upsertTags(this.tagRepository, { userId: asset.ownerId, tags: [...new Set(values)] });
      await this.visionRepository.replaceAutoTags(
        id,
        tags.map(({ id }) => id),
      );
    }

    // only the first time: one the user has taken out of the archive again stays out
    if (
      screenshot &&
      contentAnalysis.archiveScreenshots &&
      !previous &&
      asset.visibility === AssetVisibility.Timeline
    ) {
      await this.assetRepository.update({ id, visibility: AssetVisibility.Archive });
    }

    if (asset.stackId && asset.stackIsAutomatic && aesthetics) {
      await this.updateCover(asset.stackId, asset.stackPrimaryAssetId, asset.ownerId);
    }

    this.logger.debug(
      `Content analysis of ${id} (${result.ms} ms): ${labels.length} label(s)${screenshot ? ', a screenshot' : ''}` +
        (speech ? `, ${speech.segments.length} spoken segment(s) in ${speech.seconds} s` : ''),
    );
    return JobStatus.Success;
  }

  /** what is said in a video; nothing, logged, if it fails, so that the rest of its analysis is kept */
  private async listen(id: string, path: string, language: string): Promise<Pick<VisionResult, 'speech'>> {
    try {
      const result = await this.visionRepository.analyze(path, [SPEECH_TASK], { language, timeout: SPEECH_TIMEOUT });
      const error = result.error ?? (result.speech && 'error' in result.speech ? result.speech.error : undefined);
      if (error) {
        this.logger.warn(`Speech recognition of ${id} failed: ${error}`);
      }
      return { speech: result.speech };
    } catch (error) {
      this.logger.warn(`Speech recognition of ${id} failed: ${error}`);
      return {};
    }
  }

  /**
   * The cover of an automatic stack, now that one of its photos has an aesthetics score: the best by the stack's
   * rules (an edited copy, a JPEG over its raw file, a favorite, a rating), then the better taken, by a margin. A stack
   * whose cover someone chose is not automatic any more, and is left alone.
   */
  private async updateCover(stackId: string, primaryAssetId: string | null, userId: string) {
    const members = await this.stackRepository.getAutoStackMembers([stackId]);
    const cover = members.find(({ id }) => id === primaryAssetId);
    const best = members.toSorted(compareForPrimary)[0];
    if (!cover || !best || best.id === cover.id || !isBetterCover(best, cover, COVER_MIN_GAIN)) {
      return;
    }
    await this.stackRepository.update(stackId, { primaryAssetId: best.id });
    this.logger.debug(
      `Stack ${stackId}: cover ${cover.id} (${cover.aestheticScore}) -> ${best.id} (${best.aestheticScore})`,
    );
    await this.eventRepository.emit('StackUpdate', { stackId, userId });
  }
}
