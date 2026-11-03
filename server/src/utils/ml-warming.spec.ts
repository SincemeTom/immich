import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMlWarming } from 'src/utils/ml-warming.js';

describe(isMlWarming.name, () => {
  let dir: string;
  let flag: string;
  let agent: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'immich-warm-'));
    flag = join(dir, 'warming');
    agent = join(dir, 'local.immich.warm.plist');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is not, without the flag', () => {
    expect(isMlWarming({ flag, agent })).toBe(false);
  });

  it('is, while the immichctl in the flag runs', () => {
    writeFileSync(flag, `${process.pid}\n`);
    expect(isMlWarming({ flag, agent })).toBe(true);
  });

  it('is not, once the immichctl in the flag is gone (stopped, or the Mac restarted)', () => {
    writeFileSync(flag, '999999\n');
    expect(isMlWarming({ flag, agent })).toBe(false);
  });

  it('is, while the LaunchAgent that is to run it is set up', () => {
    writeFileSync(flag, 'agent\n');
    expect(isMlWarming({ flag, agent })).toBe(false);
    writeFileSync(agent, '');
    expect(isMlWarming({ flag, agent })).toBe(true);
  });

  it('is not, with something else in the flag', () => {
    writeFileSync(flag, 'nonsense\n');
    expect(isMlWarming({ flag, agent })).toBe(false);
  });
});
