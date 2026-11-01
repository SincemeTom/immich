import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetVisionTable } from 'src/schema/tables/asset-vision.table.js';
import {
  AUTO_TAG_ROOT,
  type SpeechSegment,
  type VisionCapabilities,
  type VisionLabel,
  type VisionResult,
  type VisionTask,
} from 'src/utils/content-analysis.js';

/** how long a photo may take: the first, while macOS loads its models, a few seconds; the next, tens of ms */
const REQUEST_TIMEOUT = 60_000;
/** the helper is stopped when it has had nothing to do for this long, and started again with the next photo */
const IDLE_TIMEOUT = 5 * 60_000;

/** the driver sends an array as a Postgres array; jsonb wants it as JSON */
const json = <T>(value: T) => sql<T>`${JSON.stringify(value)}::jsonb`;

type Pending = { resolve: (result: VisionResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * Apple's Vision framework, through immich-vision (macos/vision/immich-vision.swift): a helper the server starts and
 * keeps while there are photos to analyze, one JSON job per line on its stdin and one result per line on its stdout.
 * And the results, in asset_vision.
 */
@Injectable()
export class VisionRepository {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private idleTimer?: NodeJS.Timeout;
  private capabilities?: Promise<VisionCapabilities>;

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(VisionRepository.name);
  }

  private get helperPath() {
    return this.configRepository.getEnv().resourcePaths.vision;
  }

  /** whether this Mac has the helper: a native macOS install's release carries it, a container has none */
  isAvailable() {
    return process.platform === 'darwin' && existsSync(this.helperPath);
  }

  /**
   * What this Mac can do: macOS 26's requests (documents, smudge, speech) only on macOS 26. Asked once; nothing, if
   * the helper does not answer, or is one from before it said.
   */
  getCapabilities(): Promise<VisionCapabilities> {
    this.capabilities ??= new Promise<VisionCapabilities>((resolve) => {
      execFile(this.helperPath, ['capabilities'], { timeout: 30_000 }, (error, stdout) => {
        const none = { version: 0, macos: '', features: [] };
        if (error) {
          this.logger.warn(`immich-vision capabilities: ${error}`);
          return resolve(none);
        }
        try {
          resolve(JSON.parse(stdout) as VisionCapabilities);
        } catch {
          this.logger.warn(`immich-vision capabilities: not JSON: ${stdout.slice(0, 200)}`);
          resolve(none);
        }
      });
    });
    return this.capabilities;
  }

  analyze(
    path: string,
    tasks: VisionTask[],
    { language, timeout = REQUEST_TIMEOUT }: { language?: string; timeout?: number } = {},
  ): Promise<VisionResult> {
    const child = this.start();
    const id = randomUUID();
    this.resetIdleTimer();
    return new Promise<VisionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`immich-vision took more than ${timeout / 1000} s for ${path}`));
        this.stop('a request timed out');
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, path, tasks, language })}\n`);
    });
  }

  stop(reason = 'idle') {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    this.logger.debug(`Stopping immich-vision (${reason})`);
    child.stdin.end();
    setTimeout(() => child.kill(), 5000).unref();
    this.failPending(new Error(`immich-vision stopped (${reason})`));
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.logger.log(`Started immich-vision (${this.helperPath}), pid ${child.pid}`);

    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    // Vision logs to stderr now and then, for nothing that matters to us
    createInterface({ input: child.stderr }).on('line', (line) => this.logger.verbose(`immich-vision: ${line}`));
    child.stdin.on('error', (error) => this.logger.warn(`immich-vision's stdin: ${error}`));
    child.on('error', (error) => {
      this.logger.error(`immich-vision failed to start: ${error}`);
      if (this.child === child) {
        this.child = undefined;
      }
      this.failPending(error);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) {
        return;
      }

      this.child = undefined;
      this.logger.warn(`immich-vision exited (${signal ?? code})`);
      this.failPending(new Error(`immich-vision exited (${signal ?? code})`));
    });
    return child;
  }

  private onLine(line: string) {
    let result: VisionResult;
    try {
      result = JSON.parse(line) as VisionResult;
    } catch {
      this.logger.warn(`immich-vision wrote what is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    const pending = this.pending.get(result.id);
    if (!pending) {
      this.logger.warn(`immich-vision answered a request it was not sent: ${line.slice(0, 200)}`);
      return;
    }
    this.pending.delete(result.id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private failPending(error: Error) {
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(error);
      this.pending.delete(id);
    }
  }

  private resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) {
        this.stop();
      } else {
        this.resetIdleTimer();
      }
    }, IDLE_TIMEOUT);
    this.idleTimer.unref();
  }

  // --- the results ----------------------------------------------------------------------------------------------

  @GenerateSql({ params: [DummyValue.UUID] })
  getByAssetId(assetId: string) {
    return this.db.selectFrom('asset_vision').selectAll().where('assetId', '=', assetId).executeTakeFirst();
  }

  /**
   * Keeps what was found. A column left out (undefined) keeps what it had: a video's transcript, when it was not
   * listened to this time.
   */
  upsert({
    labels,
    transcriptSegments,
    ...rest
  }: Omit<Insertable<AssetVisionTable>, 'labels' | 'transcriptSegments'> & {
    labels: VisionLabel[];
    transcriptSegments?: SpeechSegment[] | null;
  }) {
    const row = Object.fromEntries(
      Object.entries({
        ...rest,
        labels: json(labels),
        transcriptSegments: transcriptSegments ? json(transcriptSegments) : transcriptSegments,
      }).filter(([, value]) => value !== undefined),
    ) as Insertable<AssetVisionTable>;
    return this.db
      .insertInto('asset_vision')
      .values(row)
      .onConflict((oc) => oc.column('assetId').doUpdateSet((eb) => ({ ...row, analyzedAt: eb.fn('now') })))
      .execute();
  }

  deleteAll() {
    return sql`truncate ${sql.table('asset_vision')}`.execute(this.db);
  }

  /** the tags content analysis gave the asset (under AUTO_TAG_ROOT), which extracting its metadata again keeps */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getAutoTagIds(assetId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('tag_asset')
      .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
      .select('tag.id')
      .where('tag_asset.assetId', '=', assetId)
      .where('tag.value', 'like', `${AUTO_TAG_ROOT}/%`)
      .execute();
    return rows.map(({ id }) => id);
  }

  /** replaces the asset's tags under AUTO_TAG_ROOT with these; leaves the others, the user's, alone */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  replaceAutoTags(assetId: string, tagIds: string[]) {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('tag_asset')
        .where('assetId', '=', assetId)
        .where('tagId', 'in', (eb) => eb.selectFrom('tag').select('id').where('value', 'like', `${AUTO_TAG_ROOT}/%`))
        .execute();
      if (tagIds.length > 0) {
        await trx
          .insertInto('tag_asset')
          .values(tagIds.map((tagId) => ({ assetId, tagId })))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });
  }
}
