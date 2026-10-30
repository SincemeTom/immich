import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export enum NetworkShareProtocol {
  Nfs = 'nfs',
}

export enum NfsVersion {
  Auto = 'auto',
  V3 = '3',
  V4 = '4',
}

/** A share as stored, under SystemMetadataKey.NetworkShares */
export interface NetworkShare {
  id: string;
  name: string;
  protocol: NetworkShareProtocol;
  host: string;
  exportPath: string;
  nfsVersion: NfsVersion;
  readOnly: boolean;
  /** the folder under the shares location it is mounted on, fixed when it is added, as libraries' paths name it */
  folder: string;
  /** whether to keep it mounted: unmounting it in the web UI turns this off, mounting it on */
  enabled: boolean;
  createdAt: string;
}

export enum NetworkShareStatus {
  /** mounted, and the server answers */
  Mounted = 'mounted',
  /** not mounted: turned off, or mounting failed */
  Unmounted = 'unmounted',
  /** mounted, but the server doesn't answer in time */
  Unresponsive = 'unresponsive',
}

/** Why mounting or reading a share failed, which the web UI explains */
export enum NetworkShareErrorReason {
  /** the server can't be reached, or doesn't run NFS */
  Unreachable = 'unreachable',
  /** the server refused: this Mac isn't allowed, or comes from a port above 1024, which Synology refuses by default */
  Denied = 'denied',
  /** the server has no such export */
  NotFound = 'not-found',
  /** macOS hasn't let the server read network volumes: someone has to allow it on the Mac */
  MacPermission = 'mac-permission',
  Other = 'other',
}

export const isNetworkSharesSupported = (location?: string): location is string =>
  !!location && process.platform === 'darwin';

export const getNetworkShareMountPath = (location: string, share: Pick<NetworkShare, 'folder'>) =>
  join(location, share.folder);

/** A folder name for a share's name: what a library path may hold, and nothing a path would read differently */
export const toShareFolder = (name: string, taken: string[]) => {
  const base =
    name
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u{0}-\u{1F}/\\:]+/gu, '-')
      .replaceAll(/^[.\s-]+|[\s-]+$/g, '')
      .slice(0, 64) || 'share';
  let folder = base;
  for (let i = 2; taken.includes(folder); i++) {
    folder = `${base}-${i}`;
  }
  return folder;
};

export const isValidHost = (host: string) =>
  // a host name or an IPv4 address; an IPv6 one in brackets, as mount_nfs takes it
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
    host,
  ) || /^\[[0-9A-Fa-f:.]+\]$/.test(host);

/** The arguments of mount_nfs for a share */
export const getNfsMountArgs = (
  share: Pick<NetworkShare, 'host' | 'exportPath' | 'nfsVersion' | 'readOnly'>,
  mountPath: string,
  port?: number,
) => {
  const options = [
    // calls fail after a while when the NAS is gone, rather than hanging the server
    'soft',
    'intr',
    'timeo=10',
    'retrans=5',
    // a mount the NAS hasn't answered for 2 minutes is dropped, then mounted again by the next check
    'deadtimeout=120',
    // one attempt: a NAS that isn't there fails now, and the next check tries again
    'retrycnt=0',
    // file names as Linux (Synology) writes them
    'nfc',
    // not in Finder's sidebar
    'nobrowse',
    'tcp',
  ];
  if (share.nfsVersion !== NfsVersion.Auto) {
    options.push(`vers=${share.nfsVersion}`);
  }
  if (share.readOnly) {
    options.push('rdonly');
  }
  if (port) {
    // for tests against an NFS server on another port, which also serves mountd on it
    options.push(`port=${port}`, `mountport=${port}`);
  }
  return ['-o', options.join(','), `${share.host}:${share.exportPath}`, mountPath];
};

/** The mount points `mount` lists for NFS, as "host:/path on /mount/point (nfs, ...)" */
export const parseNfsMounts = (output: string) => {
  const mounts = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^(.+?) on (.+) \((nfs)[,)]/.exec(line);
    if (match) {
      mounts.set(match[2], match[1]);
    }
  }
  return mounts;
};

export const classifyMountError = (message: string): NetworkShareErrorReason => {
  const text = message.toLowerCase();
  if (/operation not permitted|not permitted to access|eperm/.test(text)) {
    return NetworkShareErrorReason.MacPermission;
  }
  if (/permission denied|access denied|authentication error|auth error/.test(text)) {
    return NetworkShareErrorReason.Denied;
  }
  if (/no such file or directory|not exported|enoent/.test(text)) {
    return NetworkShareErrorReason.NotFound;
  }
  if (
    /timed out|connection refused|can't connect|host is down|no route|unknown host|can't resolve|nodename nor servname|rpc|unreachable|not responding/.test(
      text,
    )
  ) {
    return NetworkShareErrorReason.Unreachable;
  }
  return NetworkShareErrorReason.Other;
};

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type Spawn = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

/**
 * Runs a command to its end, or kills it after the timeout. Anything that touches a NAS runs in a child process
 * like this: a call that hangs on an unresponsive server would otherwise hold one of the server's I/O threads.
 */
export const runCommand = (spawn: Spawn, command: string, args: string[], timeoutMs: number) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args);
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
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error: Error) => {
      stderr += error.message;
      finish(-1);
    });
    child.on('close', (code: number | null) => finish(code));
  });
