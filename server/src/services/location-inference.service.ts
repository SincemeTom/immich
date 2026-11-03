import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { LocationInferenceClearResponseDto } from 'src/dtos/location-inference.dto.js';
import {
  AssetVisibility,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { LOCATION_INFERENCE_WINDOW_MS, inferLocation } from 'src/utils/location-inference.js';
import { batched } from 'src/utils/misc.js';

/**
 * Gives a photo without a location the one of the photos taken around it: of the photo taken just before it and the
 * one just after, within an hour each way and within a kilometer of each other, the one nearer in time. They are the
 * owner's, or in an album the owner is in (someone else's photos from the same trip). A location inferred is marked as
 * such (asset_exif.locationInferred), kept in the database only (not in the file, nor its sidecar), and its owner can
 * clear it; then it is not inferred again. One from a photo's file, or set by hand, takes its place.
 *
 * It runs after each photo's metadata is read: for one without a location, to infer it; for one with, to infer those
 * taken around it, which may have been read before it. Adding photos to an album does the same, for its users. From
 * Administration > Job Queues it runs over all photos without a location ("missing"), or also again over those with an
 * inferred one ("all").
 */
@Injectable()
export class LocationInferenceService extends BaseService {
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    await this.syncEnabled(newConfig.metadata.locationInference.enabled);
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Microservices], server: true })
  async onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    await this.syncEnabled(newConfig.metadata.locationInference.enabled);
  }

  /** Turned on (by the upgrade that adds it, too), it runs over the photos there are */
  private async syncEnabled(enabled: boolean) {
    await this.databaseRepository.withLock(DatabaseLock.LocationInference, async () => {
      const state = await this.systemMetadataRepository.get(SystemMetadataKey.LocationInference);
      if (enabled && !state?.enabled) {
        // the jobs read the config, which this worker may still hold as it was
        clearConfigCache();
        await this.jobRepository.queue({ name: JobName.AssetInferLocationQueueAll, data: { force: false } });
        this.logger.log('Location inference is on: inferring the locations of the photos without one');
      }
      if (state?.enabled !== enabled) {
        await this.systemMetadataRepository.set(SystemMetadataKey.LocationInference, { enabled });
      }
    });
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    await this.queue([assetId]);
  }

  /** After photos are added to an album: they may give a location to its users' photos taken around them */
  async queue(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    const { metadata } = await this.getConfig({ withCache: true });
    if (!metadata.locationInference.enabled) {
      return;
    }
    await this.jobRepository.queueAll(ids.map((id) => ({ name: JobName.AssetInferLocation, data: { id } })));
  }

  /** Clears the inferred location of a photo of the user's; it is not inferred again */
  async clear(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });
    await this.assetJobRepository.clearInferredLocations(id, true);
  }

  /** Clears every inferred location, of everyone's photos; turned on again, location inference infers them again */
  async clearAll(): Promise<LocationInferenceClearResponseDto> {
    const count = await this.assetJobRepository.clearInferredLocations(undefined, false);
    this.logger.log(`Cleared ${count} inferred locations`);
    return { count };
  }

  @OnJob({ name: JobName.AssetInferLocationQueueAll, queue: QueueName.LocationInference })
  async handleQueueAll({ force }: JobOf<JobName.AssetInferLocationQueueAll>): Promise<JobStatus> {
    const { metadata } = await this.getConfig({ withCache: false });
    if (!metadata.locationInference.enabled) {
      return JobStatus.Skipped;
    }

    for await (const assets of batched(this.assetJobRepository.streamForLocationInference(force))) {
      await this.jobRepository.queueAll(assets.map(({ id }) => ({ name: JobName.AssetInferLocation, data: { id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetInferLocation, queue: QueueName.LocationInference })
  async handleInferLocation({ id }: JobOf<JobName.AssetInferLocation>): Promise<JobStatus> {
    const { metadata, reverseGeocoding } = await this.getConfig({ withCache: true });
    if (!metadata.locationInference.enabled) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForLocationInference(id);
    if (!asset || asset.deletedAt || !asset.dateTimeOriginal) {
      return JobStatus.Skipped;
    }
    // the local time: one without a location often has no time zone either (LocationSource)
    const time = new Date(asset.localDateTime);

    if (asset.latitude !== null && asset.longitude !== null && asset.locationInferred !== true) {
      // one with a location of its own: the photos taken around it may now have one
      const targets = await this.assetJobRepository.getLocationInferenceTargets(
        asset.id,
        asset.ownerId,
        time,
        LOCATION_INFERENCE_WINDOW_MS,
      );
      await this.jobRepository.queueAll(
        targets.map((target) => ({ name: JobName.AssetInferLocation, data: { id: target.id } })),
      );
      return JobStatus.Success;
    }

    if (asset.visibility === AssetVisibility.Hidden || asset.locationInferred === false) {
      return JobStatus.Skipped;
    }

    const [before, after] = await Promise.all([
      this.assetJobRepository.getLocationSource(asset.ownerId, time, 'before', LOCATION_INFERENCE_WINDOW_MS),
      this.assetJobRepository.getLocationSource(asset.ownerId, time, 'after', LOCATION_INFERENCE_WINDOW_MS),
    ]);
    const location = inferLocation(time, before, after);

    if (!location) {
      if (asset.locationInferred) {
        // the photos it was inferred from are gone, or moved
        await this.assetJobRepository.clearInferredLocations(asset.id, false);
      }
      return JobStatus.Skipped;
    }

    if (asset.locationInferred && asset.latitude === location.latitude && asset.longitude === location.longitude) {
      return JobStatus.Success;
    }

    const geo = reverseGeocoding.enabled
      ? await this.mapRepository.reverseGeocode(location)
      : { city: null, state: null, country: null };
    await this.assetJobRepository.setInferredLocation(asset.id, { ...location, ...geo });

    return JobStatus.Success;
  }
}
