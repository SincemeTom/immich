// The viewer's quick rotation (r, shift+r and the menu) on a video and a photo, and the editor on a video, in Chrome,
// on the instance m1_video_rotation.py ran on. Usage: node macos/scripts/m1_video_rotation.browser.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../e2e/package.json', import.meta.url))('@playwright/test');

const url = 'http://127.0.0.1:2290';
const out = `${process.env.TMPDIR ?? '/tmp/'}video-rotation`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();
const login = await page.request.post(`${url}/api/auth/login`, {
  data: { email: 'p7@immich.local', password: 'p7-password' },
});
const { accessToken } = await login.json();
const headers = { Authorization: `Bearer ${accessToken}` };
await context.addCookies([{ name: 'immich_access_token', value: accessToken, url }]);

const api = async (path) => (await page.request.get(`${url}/api${path}`, { headers })).json();
const assets = (await (await page.request.post(`${url}/api/search/metadata`, { headers, data: { size: 50 } })).json())
  .assets.items;
const video = assets.find((a) => a.originalFileName === 'landscape.mp4');
const photo = assets.find((a) => a.originalFileName === 'shown-landscape.png');
for (const asset of [video, photo]) {
  await page.request.delete(`${url}/api/assets/${asset.id}/edits`, { headers });
}
await page.waitForTimeout(3000);
const edits = async (id) => (await api(`/assets/${id}/edits`)).edits.map((e) => `${e.action} ${Object.values(e.parameters)[0]}`);
const waitEdits = async (id, expected) => {
  for (let i = 0; i < 60; i++) {
    const current = (await edits(id)).join(', ');
    const asset = await api(`/assets/${id}`);
    if (current === expected && asset.isEdited === (expected !== '')) return current;
    await page.waitForTimeout(500);
  }
  return (await edits(id)).join(', ');
};
const videoSize = () =>
  page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { width: v.videoWidth, height: v.videoHeight } : null;
  });

console.log('== a video in the viewer');
await page.goto(`${url}/photos/${video.id}`);
await page.waitForSelector('video');
await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
let size = await videoSize();
check('plays landscape', size.width > size.height, `${size.width}x${size.height}`);

await page.keyboard.press('r');
check('r turns it right', (await waitEdits(video.id, 'rotate 90')) === 'rotate 90');
await page.waitForFunction(() => {
  const v = document.querySelector('video');
  return v && v.videoHeight > v.videoWidth;
}, null, { timeout: 30_000 }).catch(() => {});
size = await videoSize();
check('and the viewer plays it turned, without reloading the page', size.height > size.width, `${size.width}x${size.height}`);
await page.screenshot({ path: `${out}-video-rotated.png` });

await page.keyboard.press('r');
check('r again: upside down', (await waitEdits(video.id, 'rotate 180')) === 'rotate 180');
await page.keyboard.press('Shift+R');
await page.keyboard.press('Shift+R');
check('shift+r twice: as it was, the edit gone', (await waitEdits(video.id, '')) === '');

await page.getByRole('button', { name: /更多|More/ }).click();
await page.screenshot({ path: `${out}-menu.png` });
await page.getByRole('menuitem', { name: /逆时针旋转|Rotate left/ }).click().catch(async () => {
  await page.getByText(/逆时针旋转|Rotate left/).click();
});
check('the menu turns it left', (await waitEdits(video.id, 'rotate 270')) === 'rotate 270');

console.log('== the editor on a video');
await page.keyboard.press('e');
await page.waitForSelector('[aria-label="Crop area"]', { timeout: 15_000 });
const cropTitle = await page.getByRole('heading', { name: /^裁剪$|^Crop$/ }).count();
check('opens on its preview, with no crop', cropTitle === 0);
const frameHidden = await page.evaluate(() => document.querySelector('.crop-frame')?.classList.contains('hidden'));
check('nor crop frame', frameHidden === true);
await page.screenshot({ path: `${out}-editor.png` });
await page.getByRole('button', { name: /水平翻转|Flip horizontal/ }).click();
await page.getByRole('button', { name: /^保存$|^Save$/ }).click();
const saved = await waitEdits(video.id, 'mirror vertical, rotate 270');
check('saves the flip as shown: upside down before the turn, left-right after it', saved === 'mirror vertical, rotate 270', saved);

console.log('== a photo in the viewer');
await page.goto(`${url}/photos/${photo.id}`);
await page.waitForTimeout(2000);
await page.keyboard.press('r');
check('r turns a photo too', (await waitEdits(photo.id, 'rotate 90')) === 'rotate 90');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-photo-rotated.png` });
await page.keyboard.press('Shift+R');
check('shift+r turns it back', (await waitEdits(photo.id, '')) === '');

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
