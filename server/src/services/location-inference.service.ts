import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  LocationInferenceClearResponseDto,
  LocationInferenceSourceResponseDto,
} from 'src/dtos/location-inference.dto.js';
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
import {
  LocationInferenceRules,
  inferLocation,
  locationInferenceWindowMs,
  toLocationInferenceRules,
} from 'src/utils/location-inference.js';
import { batched } from 'src/utils/misc.js';

type RulesConfig = { betweenMinutes: number; nearbyMinutes: number; maxDistanceMeters: number };

/**
 * Gives a photo without a location the one of the photos taken around it (utils/location-inference.ts: between two
 * photos at the same place, or near one in time), first from its owner's photos; if none does, also from those of
 * others in an album the photo is in too (someone else's photos from the same trip). A location inferred is marked as
 * such (asset_exif.locationInferred), with the photo it was taken from (locationInferredFromId), kept in the database
 * only (not in the file, nor its sidecar), and its owner can clear it; then it is not inferred again. One from a photo's
 * file, or set by hand, takes its place.
 *
 * It runs after each photo's metadata is read: for one without a location, to infer it; for one with, to infer those
 * taken around it, which may have been read before it. Adding photos to an album does the same, for its users; removing
 * them, again for those whose locations were taken from them. From Administration > Job Queues it runs over all photos
 * without a location ("missing"), or also again over those with an inferred one ("all"); and so it does, by itself,
 * when it is turned on and when its rules change.
 */
@Injectable()
export class LocationInferenceService extends BaseService {
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    await this.syncEnabled(newConfig.metadata.locationInference);
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Microservices], server: true })
  async onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    await this.syncEnabled(newConfig.metadata.locationInference);
  }

  /**
   * Turned on (by the upgrade that adds it, too), it runs over the photos without a location; with other rules than
   * those the locations were inferred by (by the upgrade that adds them, too), also again over those inferred
   */
  private async syncEnabled({
    enabled,
    betweenMinutes,
    nearbyMinutes,
    maxDistanceMeters,
  }: { enabled: boolean } & RulesConfig) {
    const rules = { betweenMinutes, nearbyMinutes, maxDistanceMeters };
    await this.databaseRepository.withLock(DatabaseLock.LocationInference, async () => {
      const state = await this.systemMetadataRepository.get(SystemMetadataKey.LocationInference);
      const rulesChanged =
        !state?.rules ||
        state.rules.betweenMinutes !== betweenMinutes ||
        state.rules.nearbyMinutes !== nearbyMinutes ||
        state.rules.maxDistanceMeters !== maxDistanceMeters;
      if (enabled && (!state?.enabled || rulesChanged)) {
        // the jobs read the config, which this worker may still hold as it was
        clearConfigCache();
        await this.jobRepository.queue({ name: JobName.AssetInferLocationQueueAll, data: { force: !!state?.enabled } });
        this.logger.log(
          state?.enabled
            ? 'Location inference rules changed: inferring the locations of the photos again'
            : 'Location inference is on: inferring the locations of the photos without one',
        );
      }
      if (state?.enabled !== enabled || (enabled && rulesChanged)) {
        await this.systemMetadataRepository.set(SystemMetadataKey.LocationInference, {
          enabled,
          ...(enabled ? { rules } : state?.rules && { rules: state.rules }),
        });
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

  /** What the inferred location of a photo the user can see was taken from */
  async getSource(auth: AuthDto, id: string): Promise<LocationInferenceSourceResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    const source = await this.assetJobRepository.getLocationInferenceSource(id);
    if (!source) {
      return { source: null };
    }
    const visible = await this.checkAccess({ auth, permission: Permission.AssetRead, ids: [source.id] });
    return {
      source: {
        assetId: visible.has(source.id) ? source.id : null,
        localDateTime: new Date(source.localDateTime).toISOString(),
        ownerId: source.ownerId,
        ownerName: source.ownerName,
      },
    };
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
    const rules = toLocationInferenceRules(metadata.locationInference);
    const windowMs = locationInferenceWindowMs(rules);

    if (asset.latitude !== null && asset.longitude !== null && asset.locationInferred !== true) {
      // one with a location of its own: the photos taken around it may now have one
      const targets = await this.assetJobRepository.getLocationInferenceTargets(
        asset.id,
        asset.ownerId,
        time,
        windowMs,
      );
      await this.jobRepository.queueAll(
        targets.map((target) => ({ name: JobName.AssetInferLocation, data: { id: target.id } })),
      );
      return JobStatus.Success;
    }

    if (asset.visibility === AssetVisibility.Hidden || asset.locationInferred === false) {
      return JobStatus.Skipped;
    }

    // from the owner's photos; if they give none, also from those of others in an album the photo is in
    const location =
      (await this.inferFrom(asset.ownerId, time, rules, windowMs)) ??
      (await this.inferFrom(asset.ownerId, time, rules, windowMs, asset.id));

    if (!location) {
      if (asset.locationInferred) {
        // the photos it was inferred from are gone, or moved
        await this.assetJobRepository.clearInferredLocations(asset.id, false);
      }
      return JobStatus.Skipped;
    }

    if (
      asset.locationInferred &&
      asset.latitude === location.latitude &&
      asset.longitude === location.longitude &&
      asset.locationInferredFromId === location.sourceId
    ) {
      return JobStatus.Success;
    }

    const { sourceId, ...coordinates } = location;
    const geo = reverseGeocoding.enabled
      ? await this.mapRepository.reverseGeocode(coordinates)
      : { city: null, state: null, country: null };
    await this.assetJobRepository.setInferredLocation(asset.id, { ...coordinates, ...geo, sourceId });

    return JobStatus.Success;
  }

  private async inferFrom(
    ownerId: string,
    time: Date,
    rules: LocationInferenceRules,
    windowMs: number,
    sharedWith?: string,
  ) {
    const [before, after] = await Promise.all([
      this.assetJobRepository.getLocationSource(ownerId, time, 'before', windowMs, sharedWith),
      this.assetJobRepository.getLocationSource(ownerId, time, 'after', windowMs, sharedWith),
    ]);
    return inferLocation(time, before, after, rules);
  }
}
