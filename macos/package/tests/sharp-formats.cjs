// Decodes each sample through sharp, as the server does, and reports what each became; fails if any does not load.
// Usage (from <release>/server, with run-service's environment): node sharp-formats.cjs SAMPLE...
const sharp = require('sharp');
const path = require('node:path');

(async () => {
  let failed = 0;
  for (const file of process.argv.slice(2)) {
    try {
      const { format } = await sharp(file).metadata();
      const { info } = await sharp(file, { failOn: 'none' }).rotate().resize(200).jpeg().toBuffer({ resolveWithObject: true });
      console.log(`  ok    ${path.basename(file)}: ${format}, ${info.width}x${info.height}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL  ${path.basename(file)}: ${error.message.split('\n')[0]}`);
    }
  }
  const loaders = Object.keys(sharp.format).filter((k) => sharp.format[k].input.file);
  console.log(`  libvips ${sharp.versions.vips}, loaders: ${loaders.join(' ')}`);
  process.exit(failed ? 1 : 0);
})();
