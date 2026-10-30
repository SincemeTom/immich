import { Injectable } from '@nestjs/common';
import type { AutoStackPreferences, JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AutoStackRemoveResponseDto } from 'src/dtos/auto-stack.dto.js';
import { AssetType, AssetVisibility, JobName, JobStatus, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  AutoStackCandidate,
  AutoStackReason,
  compareForPrimary,
  getAutoStackNameKeys,
  getAutoStackReasons,
  shouldReplacePrimary,
} from 'src/utils/auto-stack.js';
import { batched } from 'src/utils/misc.js';
import { getPreferences } from 'src/utils/preferences.js';

const REASON_ORDER = Object.values(AutoStackReason);

/**
 * Stacks each user's photos as their preferences say: the photos of a burst, a raw file with its JPEG, an edited copy
 * with its original, photos that look alike taken within seconds. It runs after each upload and library import, and
 * from Administration > Job Queues over everyone's photos, or from a user's settings over theirs.
 *
 * It only adds: it never takes an asset out of a stack, merges two stacks, or changes a stack a user made but to add
 * to it. An asset someone takes out of a stack it made is left alone, until they ask for everything to be stacked again.
 */
@Injectable()
export class AutoStackService extends BaseService {
  /** Stacks a user's photos again: theirs that are not in a stack, or with `force` also those taken out of one */
  async run(auth: AuthDto, force = false): Promise<void> {
    await this.jobRepository.queue({ name: JobName.AssetAutoStackQueueAll, data: { userId: auth.user.id, force } });
  }

  /** Removes the stacks auto stacking made for a user; their assets stay */
  async removeAll(auth: AuthDto): Promise<AutoStackRemoveResponseDto> {
    const count = await this.stackRepository.removeAutomatic(auth.user.id);
    if (count > 0) {
      this.logger.log(`Removed ${count} automatic stacks of user ${auth.user.id}`);
      this.websocketRepository.clientSend('on_asset_stack_update', auth.user.id);
    }
    return { count };
  }

  @OnJob({ name: JobName.AssetAutoStackQueueAll, queue: QueueName.AutoStack })
  async handleQueueAll({ force, userId }: JobOf<JobName.AssetAutoStackQueueAll>): Promise<JobStatus> {
    const everyone = userId ? [] : await this.userRepository.getList({ withDeleted: false });
    const users = userId ? [userId] : everyone.map(({ id }) => id);
    const ownerIds: string[] = [];
    for (const id of users) {
      if (await this.getAutoStackPreferences(id)) {
        ownerIds.push(id);
      }
    }
    if (ownerIds.length === 0) {
      return JobStatus.Skipped;
    }

    if (force) {
      for (const id of ownerIds) {
        await this.stackRepository.resetAutoStacked(id);
      }
    }

    for await (const assets of batched(this.stackRepository.streamForAutoStack(ownerIds, !!force))) {
      await this.jobRepository.queueAll(assets.map(({ id }) => ({ name: JobName.AssetAutoStack, data: { id } })));
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetAutoStack, queue: QueueName.AutoStack })
  async handleAutoStack({ id }: JobOf<JobName.AssetAutoStack>): Promise<JobStatus> {
    const asset = await this.stackRepository.getForAutoStack(id);
    if (
      !asset ||
      asset.deletedAt ||
      asset.stackId ||
      asset.autoStackedAt ||
      ![AssetVisibility.Timeline, AssetVisibility.Archive].includes(asset.visibility)
    ) {
      return JobStatus.Skipped;
    }

    const preferences = await this.getAutoStackPreferences(asset.ownerId);
    if (!preferences) {
      return JobStatus.Skipped;
    }

    const fileCreatedAt = new Date(asset.fileCreatedAt);
    const similar =
      preferences.similar && asset.type === AssetType.Image && asset.embedding
        ? {
            from: new Date(fileCreatedAt.getTime() - preferences.maxSeconds * 1000),
            to: new Date(fileCreatedAt.getTime() + preferences.maxSeconds * 1000),
            embedding: asset.embedding,
          }
        : undefined;
    const candidates = await this.stackRepository.getAutoStackCandidates({
      ownerId: asset.ownerId,
      assetId: asset.id,
      autoStackId: preferences.burst ? asset.autoStackId : null,
      nameKeys: preferences.rawJpeg || preferences.edited ? getAutoStackNameKeys(asset.originalFileName) : [],
      similar,
    });

    const matches = candidates
      // taken out of a stack auto stacking made: someone decided it does not belong
      .filter((candidate) => candidate.stackId || !candidate.autoStackedAt)
      .map((candidate) => ({ candidate, reasons: getAutoStackReasons(asset, candidate, preferences) }))
      .filter(({ reasons }) => reasons.length > 0)
      .sort((a, b) => strength(a) - strength(b) || (a.candidate.distance ?? 0) - (b.candidate.distance ?? 0));
    if (matches.length === 0) {
      return JobStatus.Skipped;
    }

    const autoStackedAt = new Date();
    const loose = matches.filter(({ candidate }) => !candidate.stackId).map(({ candidate }) => candidate);
    const stacked = matches.find(({ candidate }) => candidate.stackId)?.candidate;

    if (stacked?.stackId) {
      // joins the stack the closest match is in; another stack is never merged into it
      const added = [asset.id, ...loose.map(({ id }) => id)];
      await this.stackRepository.addAssets(stacked.stackId, added);
      await this.assetRepository.upsertJobStatus(...added.map((assetId) => ({ assetId, autoStackedAt })));

      const primary = candidates.find((candidate) => candidate.id === stacked.primaryAssetId);
      const newPrimary = [asset, ...loose].sort(compareForPrimary)[0];
      if (stacked.isAutomatic && primary && shouldReplacePrimary(newPrimary, primary)) {
        await this.stackRepository.update(stacked.stackId, { primaryAssetId: newPrimary.id });
      }

      this.logger.debug(`Added ${added.length} assets to stack ${stacked.stackId} (${reasonsOf(matches)})`);
      await this.eventRepository.emit('StackUpdate', { stackId: stacked.stackId, userId: asset.ownerId });
      return JobStatus.Success;
    }

    const assets = [asset, ...loose].sort(compareForPrimary);
    const stack = await this.stackRepository.create(
      { ownerId: asset.ownerId, isAutomatic: true },
      assets.map(({ id }) => id),
    );
    await this.assetRepository.upsertJobStatus(...assets.map(({ id: assetId }) => ({ assetId, autoStackedAt })));

    this.logger.debug(`Stacked ${assets.length} assets as ${stack.id} (${reasonsOf(matches)})`);
    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: asset.ownerId });
    return JobStatus.Success;
  }

  /** The user's auto stacking preferences, when it is on and has something to stack */
  private async getAutoStackPreferences(userId: string): Promise<AutoStackPreferences | undefined> {
    const { autoStack } = getPreferences(await this.userRepository.getMetadata(userId));
    const anyRule = autoStack.burst || autoStack.rawJpeg || autoStack.edited || autoStack.similar;
    return autoStack.enabled && anyRule ? autoStack : undefined;
  }
}

type Match = { candidate: AutoStackCandidate; reasons: AutoStackReason[] };

const strength = ({ reasons }: Match) => Math.min(...reasons.map((reason) => REASON_ORDER.indexOf(reason)));

const reasonsOf = (matches: Match[]) => [...new Set(matches.flatMap(({ reasons }) => reasons))].join(', ');
