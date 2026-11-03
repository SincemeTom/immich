import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { VisionRepository } from 'src/repositories/vision.repository.js';

/**
 * A stand-in for immich-vision: answers each job at once with the path it was given and how many speech jobs it had
 * then; a path with "stuck" in it makes it stop answering anything, as the real one did with as many videos at once
 * as the Mac has cores (macos/verification/m4-vision-speech-deadlock.md); a speech job is answered after 50 ms.
 */
const FAKE_HELPER = String.raw`#!/usr/bin/env node
const { createInterface } = require('node:readline');
let stuck = false;
let speech = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const job = JSON.parse(line);
  if (job.path.includes('stuck')) stuck = true;
  if (stuck) return;
  const answer = (extra) => process.stdout.write(JSON.stringify({ id: job.id, path: job.path, pid: process.pid, ...extra }) + '\n');
  if (job.tasks.includes('speech')) {
    speech++;
    const atOnce = speech;
    setTimeout(() => { speech--; if (!stuck) answer({ atOnce }); }, 100);
  } else {
    answer({});
  }
});
`;

describe(VisionRepository.name, () => {
  let dir: string;
  let sut: VisionRepository;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'immich-vision-'));
    const helper = join(dir, 'immich-vision');
    writeFileSync(helper, FAKE_HELPER);
    chmodSync(helper, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    const config = { getEnv: () => ({ resourcePaths: { vision: join(dir, 'immich-vision') } }) } as ConfigRepository;
    const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
    sut = new VisionRepository(undefined as any, config, logger as unknown as LoggingRepository);
  });

  afterEach(() => sut.stop('test'));

  it('answers each request with its own result', async () => {
    const [a, b] = await Promise.all([sut.analyze('/a.jpeg', ['classify']), sut.analyze('/b.jpeg', ['classify'])]);
    expect(a).toMatchObject({ path: '/a.jpeg' });
    expect(b).toMatchObject({ path: '/b.jpeg' });
  });

  it('when a request times out, replaces the helper and sends it what the old one still had', async () => {
    const before = (await sut.analyze('/before.jpeg', ['classify'])) as unknown as { pid: number };
    const stuck = sut.analyze('/stuck.jpeg', ['classify'], { timeout: 200 });
    const waiting = sut.analyze('/waiting.jpeg', ['classify'], { timeout: 5000 });

    await expect(stuck).rejects.toThrow('immich-vision took more than 0.2 s for /stuck.jpeg');
    const result = (await waiting) as unknown as { path: string; pid: number };
    expect(result.path).toBe('/waiting.jpeg');
    expect(result.pid).not.toBe(before.pid);
  });

  it('fails a request that was sent again and is stuck again', async () => {
    const stuck = sut.analyze('/stuck-1.jpeg', ['classify'], { timeout: 200 });
    const twice = sut.analyze('/stuck-2.jpeg', ['classify'], { timeout: 400 });

    await expect(stuck).rejects.toThrow('took more than 0.2 s');
    await expect(twice).rejects.toThrow(/took more than 0.4 s|twice/);
  });

  it('listens to no more than two videos at once, and starts the time of the others when they are sent', async () => {
    // the helper started first: under load (the whole suite at once) starting it can take longer than the timeout
    await sut.analyze('/warm.jpeg', ['classify']);
    // three rounds of 100 ms: timed from when they are queued, the last two would time out at 250 ms
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => sut.analyze(`/video-${i}.mov`, ['speech'], { timeout: 250 })),
    );
    for (const result of results) {
      expect((result as unknown as { atOnce: number }).atOnce).toBeLessThanOrEqual(2);
    }
  });
});
