import { eventManager } from '$lib/managers/event-manager.svelte';
import { EDIT_BACKGROUND_WAIT, EDIT_WAIT, listenForEditsApplied } from '$lib/utils/asset-edit-ready';

type Handler = (event: { asset: { id: string } }) => void;
const handlers = new Set<Handler>();

vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: (_event: string, handler: Handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  },
}));

const ready = (id: string) => {
  for (const handler of handlers) {
    handler({ asset: { id } });
  }
};

describe('listenForEditsApplied', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    vi.spyOn(eventManager, 'emit');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is ready once the asset is, and shows it', async () => {
    const edit = listenForEditsApplied('asset-1');
    const isReady = edit.ready();

    ready('asset-2');
    ready('asset-1');

    await expect(isReady).resolves.toBe(true);
    expect(eventManager.emit).toHaveBeenCalledExactlyOnceWith('AssetEditsApplied', 'asset-1');
    expect(handlers.size).toBe(0);
  });

  it('goes on in the background after a while, as on a network library, and shows the asset once it is ready', async () => {
    const edit = listenForEditsApplied('asset-1');
    const isReady = edit.ready();

    await vi.advanceTimersByTimeAsync(EDIT_WAIT);
    await expect(isReady).resolves.toBe(false);
    expect(eventManager.emit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    ready('asset-1');

    await expect(edit.applied).resolves.toBe(true);
    expect(eventManager.emit).toHaveBeenCalledWith('AssetEditsApplied', 'asset-1');
  });

  it('gives up in the end, and when the edits were not sent', async () => {
    const late = listenForEditsApplied('asset-1');
    await vi.advanceTimersByTimeAsync(EDIT_BACKGROUND_WAIT);
    await expect(late.applied).resolves.toBe(false);

    const unsent = listenForEditsApplied('asset-2');
    unsent.cancel();
    await expect(unsent.applied).resolves.toBe(false);

    expect(handlers.size).toBe(0);
    expect(eventManager.emit).not.toHaveBeenCalled();
  });
});
