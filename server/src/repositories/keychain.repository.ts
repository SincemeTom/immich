import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { CommandResult } from 'src/utils/network-share.js';

const SECURITY = '/usr/bin/security';
const TIMEOUT = 10_000;
/** errSecItemNotFound, as `security` exits */
const NOT_FOUND = 44;

/**
 * Secrets in the login Keychain of the macOS user the server runs as (it is a LaunchAgent of the logged-in user, so
 * that Keychain is unlocked, and items `security` made can be read by it without asking).
 *
 * The secret never goes on a command line, where `ps` would show it: `security` reads it from stdin, twice (it asks to
 * retype it), and is started in a session of its own, without a terminal, as otherwise it reads the terminal instead.
 * It is written as base64, as `security` prints anything but printable ASCII as hex, which could not be told apart
 * from a secret that looks like hex; and is read back, as `security` stores an empty secret when the two lines differ.
 */
@Injectable()
export class KeychainRepository {
  spawn = spawn;

  async get(service: string, account: string): Promise<string | null> {
    const result = await this.run(['find-generic-password', '-s', service, '-a', account, '-w']);
    if (result.code === NOT_FOUND) {
      return null;
    }

    this.check(result, 'read');
    return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  }

  async set(service: string, account: string, value: string, label = service): Promise<void> {
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    const result = await this.run(
      ['add-generic-password', '-U', '-s', service, '-a', account, '-l', label, '-w'],
      `${encoded}\n${encoded}\n`,
    );
    this.check(result, 'write');

    if ((await this.get(service, account)) !== value) {
      throw new Error('The Keychain did not keep what was written to it');
    }
  }

  async delete(service: string, account: string): Promise<boolean> {
    const result = await this.run(['delete-generic-password', '-s', service, '-a', account]);
    if (result.code === NOT_FOUND) {
      return false;
    }

    this.check(result, 'delete');
    return true;
  }

  private check(result: CommandResult, action: string) {
    if (result.code === 0) {
      return;
    }

    const reason = result.timedOut
      ? `no answer within ${TIMEOUT / 1000} s`
      : result.stderr.trim() || `security exited with ${result.code}`;
    throw new Error(`Could not ${action} the Keychain item: ${reason}`);
  }

  private run(args: string[], input?: string) {
    return new Promise<CommandResult>((resolve) => {
      const child = this.spawn(SECURITY, args, { detached: true, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let done = false;
      const finish = (code: number | null) => {
        if (done) {
          return;
        }

        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        finish(null);
      }, TIMEOUT);
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error: Error) => {
        stderr += error.message;
        finish(-1);
      });
      child.on('close', (code: number | null) => finish(code));
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    });
  }
}
