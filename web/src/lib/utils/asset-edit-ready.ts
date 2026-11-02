import { eventManager } from '$lib/managers/event-manager.svelte';
import { websocketEvents } from '$lib/stores/websocket';

/** How long an edit is waited for before it is told to go on in the background */
export const EDIT_WAIT = 30_000;
/** How long the background waits for it, after which it gives up: the job failed, or the server went away */
export const EDIT_BACKGROUND_WAIT = 30 * 60_000;

/**
 * Listens for an asset's edits to be applied, to be called before they are sent so as not to miss a quick job.
 *
 * The server takes the edits at once and applies them in a job, which on a network library pays the share's latency
 * on every read and write: minutes, at times, for a small image. So the client does not fail an edit it is still
 * waiting for: `ready()` tells whether it was applied within `EDIT_WAIT`, and once it is, however much later,
 * `AssetEditsApplied` shows it.
 */
export const listenForEditsApplied = (assetId: string) => {
  let resolveApplied: (applied: boolean) => void = () => {};
  const applied = new Promise<boolean>((resolve) => (resolveApplied = resolve));

  const off = websocketEvents.on('AssetEditReadyV2', (event) => {
    if (event.asset.id === assetId) {
      stop(true);
      eventManager.emit('AssetEditsApplied', assetId);
    }
  });
  const timer = setTimeout(() => stop(false), EDIT_BACKGROUND_WAIT);

  function stop(isApplied: boolean) {
    off();
    clearTimeout(timer);
    resolveApplied(isApplied);
  }

  return {
    /** whether the edits were applied, once they are, or false once the background gives up */
    applied,
    /** stops listening: the edits were not sent */
    cancel: () => stop(false),
    /** whether the edits were applied within `wait`: if not, they go on in the background */
    ready: (wait = EDIT_WAIT) =>
      Promise.race([applied, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), wait))]),
  };
};
