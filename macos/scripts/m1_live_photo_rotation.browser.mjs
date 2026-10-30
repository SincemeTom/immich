// A live photo in Chrome: r turns it, its motion plays turned too, and the editor offers no crop.
// On the instance m1_live_photo_rotation.py ran on. Usage: node macos/scripts/m1_live_photo_rotation.browser.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../e2e/package.json', import.meta.url))('@playwright/test');

const url = 'http://127.0.0.1:2291';
const out = `${process.env.TMPDIR ?? '/tmp/'}live-photo-rotation`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();
const login = await page.request.post(`${url}/api/auth/login`, {
  data: { email: 'p8@immich.local', password: 'p8-password' },
});
const { accessToken } = await login.json();
const headers = { Authorization: `Bearer ${accessToken}` };
await context.addCookies([{ name: 'immich_access_token', value: accessToken, url }]);

const search = await page.request.post(`${url}/api/search/metadata`, { headers, data: { size: 50 } });
const photo = (await search.json()).assets.items.find((a) => a.originalFileName === 'IMG_5895.HEIC');
const api = async (path) => (await page.request.get(`${url}/api${path}`, { headers })).json();
const edits = async (id) =>
  (await api(`/assets/${id}/edits`)).edits.map((e) => `${e.action} ${Object.values(e.parameters)[0]}`).join(', ');
const waitEdits = async (id, expected) => {
  for (let i = 0; i < 60; i++) {
    if ((await edits(id)) === expected && (await api(`/assets/${id}`)).isEdited === (expected !== '')) break;
    await page.waitForTimeout(500);
  }
  return edits(id);
};
const playMotion = async () => {
  await page.getByRole('button', { name: /播放动态图片|Play Motion Photo/i }).click();
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, null, { timeout: 20_000 });
  const size = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { width: v.videoWidth, height: v.videoHeight };
  });
  await page.getByRole('button', { name: /定格照片|Stop Motion Photo/i }).click().catch(() => {});
  return size;
};

console.log('== a live photo in the viewer');
await page.goto(`${url}/photos/${photo.id}`);
await page.waitForTimeout(2500);
let size = await playMotion();
check('its motion plays upright', size.height > size.width, `${size.width}x${size.height}`);

await page.keyboard.press('r');
check('r turns it', (await waitEdits(photo.id, 'rotate 90')) === 'rotate 90');
check('its motion takes the turn', (await edits(photo.livePhotoVideoId)) === 'rotate 90');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-photo.png` });
size = await playMotion();
check('and plays turned, without reloading the page', size.width > size.height, `${size.width}x${size.height}`);
await page.screenshot({ path: `${out}-motion.png` });

console.log('== the editor');
await page.keyboard.press('e');
await page.waitForSelector('[aria-label="Crop area"]', { timeout: 15_000 });
check('opens with no crop', (await page.getByRole('heading', { name: /^裁剪$|^Crop$/ }).count()) === 0);
await page.screenshot({ path: `${out}-editor.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(1000);

await page.keyboard.press('Shift+R');
check('shift+r turns it back, its motion too', (await waitEdits(photo.id, '')) === '' && (await edits(photo.livePhotoVideoId)) === '');

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
