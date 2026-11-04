import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { KeychainRepository } from 'src/repositories/keychain.repository.js';

type Reply = { code?: number | null; stdout?: string; stderr?: string; hang?: boolean; error?: Error };

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');

describe(KeychainRepository.name, () => {
  let sut: KeychainRepository;
  let replies: Reply[];
  let written: string[];
  let spawn: ReturnType<typeof vi.fn>;
  let killed: number;

  beforeEach(() => {
    sut = new KeychainRepository();
    replies = [];
    written = [];
    killed = 0;
    spawn = vi.fn(() => {
      const { code = 0, stdout = '', stderr = '', hang = false, error } = replies.shift() ?? {};
      let input = '';
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new Writable({
          write(chunk, _encoding, callback) {
            input += chunk.toString();
            callback();
          },
          final(callback) {
            written.push(input);
            callback();
          },
        }),
        kill: () => {
          killed++;
          return true;
        },
      });
      setImmediate(() => {
        if (error) {
          child.emit('error', error);
          return;
        }
        child.stdout.end(stdout);
        child.stderr.end(stderr);
        if (!hang) {
          setImmediate(() => child.emit('close', code));
        }
      });
      return child;
    });
    sut.spawn = spawn as any;
  });

  describe('get', () => {
    it('should read the item, without a terminal', async () => {
      replies.push({ stdout: `${encode('p@ss "中文" \\')}\n` });

      await expect(sut.get('Immich Synology', 'user-1')).resolves.toBe('p@ss "中文" \\');
      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Immich Synology', '-a', 'user-1', '-w'],
        { detached: true, stdio: 'pipe' },
      );
    });

    it('should give null when there is none', async () => {
      replies.push({ code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found' });

      await expect(sut.get('Immich Synology', 'user-1')).resolves.toBeNull();
    });

    it('should fail on any other error', async () => {
      replies.push({ code: 36, stderr: 'User interaction is not allowed.' });

      await expect(sut.get('Immich Synology', 'user-1')).rejects.toThrow(
        'Could not read the Keychain item: User interaction is not allowed.',
      );
    });

    it('should not wait for ever', async () => {
      vi.useFakeTimers();
      try {
        replies.push({ hang: true });
        const promise = sut.get('Immich Synology', 'user-1');
        const assertion = expect(promise).rejects.toThrow('no answer within 10 s');
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;
        expect(killed).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should fail when security cannot be started', async () => {
      replies.push({ error: new Error('spawn /usr/bin/security ENOENT') });

      await expect(sut.get('Immich Synology', 'user-1')).rejects.toThrow('spawn /usr/bin/security ENOENT');
    });
  });

  describe('set', () => {
    it('should write the secret on stdin, twice, never as an argument, and read it back', async () => {
      const value = String.raw`{"password":"p@ss \"w0rd\" 中文"}`;
      replies.push({}, { stdout: `${encode(value)}\n` });

      await sut.set('Immich Synology', 'user-1', value, 'Immich: Synology account of alice');

      const [, args] = spawn.mock.calls[0];
      expect(args).toEqual([
        'add-generic-password',
        '-U',
        '-s',
        'Immich Synology',
        '-a',
        'user-1',
        '-l',
        'Immich: Synology account of alice',
        '-w',
      ]);
      expect(JSON.stringify(spawn.mock.calls)).not.toContain('w0rd');
      expect(written[0]).toBe(`${encode(value)}\n${encode(value)}\n`);
      expect(spawn.mock.calls[1][1]).toEqual(['find-generic-password', '-s', 'Immich Synology', '-a', 'user-1', '-w']);
    });

    it('should fail when the Keychain kept something else', async () => {
      replies.push({}, { stdout: '\n' });

      await expect(sut.set('Immich Synology', 'user-1', 'secret')).rejects.toThrow(
        'The Keychain did not keep what was written to it',
      );
    });

    it('should fail when it cannot write', async () => {
      replies.push({
        code: 51,
        stderr: 'security: SecKeychainItemCreateFromContent: The user name or passphrase you entered is not correct.',
      });

      await expect(sut.set('Immich Synology', 'user-1', 'secret')).rejects.toThrow('Could not write the Keychain item');
    });
  });

  describe('delete', () => {
    it('should delete the item', async () => {
      replies.push({});

      await expect(sut.delete('Immich Synology', 'user-1')).resolves.toBe(true);
      expect(spawn.mock.calls[0][1]).toEqual(['delete-generic-password', '-s', 'Immich Synology', '-a', 'user-1']);
    });

    it('should not fail when there is none', async () => {
      replies.push({ code: 44 });

      await expect(sut.delete('Immich Synology', 'user-1')).resolves.toBe(false);
    });

    it('should fail on any other error', async () => {
      replies.push({ code: 1, stderr: 'locked' });

      await expect(sut.delete('Immich Synology', 'user-1')).rejects.toThrow(
        'Could not delete the Keychain item: locked',
      );
    });
  });
});
