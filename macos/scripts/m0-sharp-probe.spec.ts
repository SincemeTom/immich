/**
 * M0 probe, not a unit test: runs the server's own MediaRepository over every image in e2e/test-assets/formats with the
 * default thumbnail settings (P3, 1440px JPEG preview, 250px WebP thumbnail, thumbhash), using whichever sharp/libvips
 * the server resolves. Run with macos/scripts/m0-sharp-probe.sh, which places it under server/src for the run.
 */
import { readdirSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { Colorspace, ImageFormat } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MediaRepository } from 'src/repositories/media.repository';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../..'); // as copied to server/src
const assets = join(repo, 'e2e/test-assets/formats');
const output = process.env.M0_SHARP_WORK ?? '/tmp/immich-m0/sharp';
const skipped = new Set(['.xmp', '.md', '.mp4', '.mov']);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name.startsWith('.')) {
      return [];
    }
    return statSync(path).isDirectory() ? walk(path) : skipped.has(extname(name).toLowerCase()) ? [] : [path];
  });

const logger = { setContext: () => {}, log: () => {}, debug: () => {}, verbose: () => {}, warn: () => {}, error: () => {} };
const media = new MediaRepository(logger as unknown as LoggingRepository);
const files = walk(assets).sort();

describe(`MediaRepository with libvips ${sharp.versions.vips}`, () => {
  it('reports the sharp build', async () => {
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    const inputs = Object.entries(sharp.format)
      .filter(([, format]) => format.input.file)
      .map(([name]) => name);
    console.log(`sharp ${sharp.versions.sharp ?? ''} libvips ${sharp.versions.vips}, inputs: ${inputs.join(' ')}`);
  });

  it.each(files.map((file) => [relative(assets, file), file]))('%s', async (_, file) => {
    const name = relative(assets, file).replaceAll('/', '_');
    const started = performance.now();
    const decoded = await media.decodeImage(file, { colorspace: Colorspace.P3, processInvalidImages: false, size: 1440 });
    const common = { colorspace: Colorspace.P3, processInvalidImages: false, progressive: false, quality: 80, edits: [] };
    await media.generateThumbnail(
      decoded,
      { ...common, format: ImageFormat.Jpeg, size: 1440 },
      join(output, `${name}.preview.jpeg`),
    );
    await media.generateThumbnail(decoded, { ...common, format: ImageFormat.Webp, size: 250 }, join(output, `${name}.thumb.webp`));
    const thumbhash = await media.generateThumbhash(decoded, { colorspace: Colorspace.P3, processInvalidImages: false, edits: [] });
    const preview = await sharp(join(output, `${name}.preview.jpeg`)).metadata();
    console.log(
      `${relative(assets, file)}: decoded ${decoded.info.width}x${decoded.info.height}, preview ${preview.width}x${preview.height}` +
        ` ${preview.icc ? 'with ICC' : 'no ICC'}, thumbhash ${thumbhash.length}B, ${Math.round(performance.now() - started)}ms`,
    );
    expect(Math.max(preview.width ?? 0, preview.height ?? 0)).toBeGreaterThan(0);
    expect(thumbhash.length).toBeGreaterThan(0);
  });
});
