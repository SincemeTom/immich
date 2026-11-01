import { Injectable } from '@nestjs/common';

import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AssetType, AssetVisibility, JobName, JobStatus, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  CONTENT_ANALYSIS_VERSION,
  QR_CODE_TAG,
  SCREENSHOT_TAG,
  type VisionLabel,
  getLabelTags,
  hasQrCode,
  isScreenshot,
  succeeded,
} from 'src/utils/content-analysis.js';
import { batched, isContentAnalysisEnabled } from 'src/utils/misc.js';
import { upsertTags } from 'src/utils/tag.js';

/**
 * Content analysis, on macOS: Apple's Vision framework on each asset's preview (VisionRepository), for tags in
 * Chinese under "自动" ("自动/动物/猫"), screenshots (tagged, and archived if the settings say so), QR codes, and an
 * aesthetics score. macos/verification/m4-vision-research.md is what it is based on.
 */
@Injectable()
export class ContentAnalysisService extends BaseService {
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

    // all of them again (force), or those not analyzed by this version; the results are kept until each is replaced,
    // so that a screenshot archived once, and taken out of the archive, stays out of it
    const stream = this.assetJobRepository.streamForContentAnalysis(CONTENT_ANALYSIS_VERSION, force);
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

    const previous = await this.visionRepository.getByAssetId(id);
    const result = await this.visionRepository.analyze(asset.previewFile, [
      'classify',
      'aesthetics',
      'animals',
      'barcodes',
    ]);
    if (result.error) {
      this.logger.warn(`Content analysis of ${id} failed: ${result.error}`);
      return JobStatus.Failed;
    }

    const labels = succeeded<VisionLabel[]>(result.classify) ?? [];
    const animals = succeeded<VisionLabel[]>(result.animals) ?? [];
    const aesthetics = succeeded(result.aesthetics);
    const barcodes = succeeded(result.barcodes) ?? [];
    const screenshot =
      asset.type === AssetType.Image &&
      isScreenshot({
        originalFileName: asset.originalFileName,
        make: asset.make,
        model: asset.model,
        width: asset.exifImageWidth ?? asset.width,
        height: asset.exifImageHeight ?? asset.height,
        labels,
      });

    await this.visionRepository.upsert({
      assetId: id,
      version: CONTENT_ANALYSIS_VERSION,
      aestheticScore: aesthetics?.score ?? null,
      isUtility: aesthetics?.utility ?? null,
      isScreenshot: screenshot,
      labels,
      barcodes: barcodes.map(({ payload }) => payload),
    });

    if (contentAnalysis.tags) {
      const values = getLabelTags(labels, animals);
      if (screenshot) {
        values.push(SCREENSHOT_TAG);
      }
      if (hasQrCode(barcodes)) {
        values.push(QR_CODE_TAG);
      }
      const tags = await upsertTags(this.tagRepository, { userId: asset.ownerId, tags: values });
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

    this.logger.debug(
      `Content analysis of ${id} (${result.ms} ms): ${labels.length} label(s)${screenshot ? ', a screenshot' : ''}`,
    );
    return JobStatus.Success;
  }
}
