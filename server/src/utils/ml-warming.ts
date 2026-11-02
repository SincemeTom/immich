import { existsSync, readFileSync } from 'node:fs';
import { QueueName } from 'src/enum.js';

/** the queues whose jobs call the machine learning service: they wait while a native install warms its models up */
export const ML_QUEUES = [QueueName.SmartSearch, QueueName.FaceDetection, QueueName.Ocr];

/**
 * Whether `immichctl warm` is preparing the models, as its flag file says (the same test as run-service's `warming`):
 * the pid of the immichctl that runs it, while that runs; or `agent` while the one-off LaunchAgent that runs it in the
 * background is set up and has not started it yet.
 */
export const isMlWarming = ({ flag, agent }: { flag: string; agent?: string }): boolean => {
  let holder: string;
  try {
    holder = readFileSync(flag, 'utf8').trim();
  } catch {
    return false;
  }
  if (holder === 'agent') {
    return agent ? existsSync(agent) : true;
  }
  if (!/^\d+$/.test(holder)) {
    return false;
  }
  try {
    process.kill(Number(holder), 0);
    return true;
  } catch (error) {
    // there, but not ours to signal
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
