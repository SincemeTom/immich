import type { ServerStorageResponseDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import { userInteraction } from '$lib/stores/user.svelte';
import StorageSpace from './StorageSpace.svelte';

vi.mock('$lib/utils/auth', () => ({ requestServerInfo: vi.fn() }));

const GiB = 1024 ** 3;
const info = (overrides: Partial<ServerStorageResponseDto> = {}): ServerStorageResponseDto => ({
  diskSize: '1000 GiB',
  diskUse: '300 GiB',
  diskAvailable: '600 GiB',
  diskSizeRaw: 1000 * GiB,
  diskUseRaw: 300 * GiB,
  diskAvailableRaw: 600 * GiB,
  diskUsagePercentage: 30,
  usageUploads: 100 * GiB,
  usageExternal: 200 * GiB,
  quotaSizeInBytes: null,
  sharesNotCounted: 0,
  ...overrides,
});

describe('StorageSpace component', () => {
  afterEach(() => {
    userInteraction.serverInfo = undefined;
  });

  it("should show what the user's photos take of the server's storage, external libraries too", () => {
    userInteraction.serverInfo = info();
    render(StorageSpace);

    const box = screen.getByTestId('storage-space');
    expect(box).toHaveTextContent('storage_usage');
    expect(box.title).toContain('storage_usage_detail');
    expect(box.title).not.toContain('storage_quota_counts_uploads');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0.3');
  });

  it('should show it of the quota, when the user has one', () => {
    userInteraction.serverInfo = info({ quotaSizeInBytes: 200 * GiB });
    render(StorageSpace);

    const box = screen.getByTestId('storage-space');
    expect(box.title).toContain('storage_quota_counts_uploads');
    // more than the quota, with the external libraries: full
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '1');
  });

  it('should tell when network shares are not counted', () => {
    userInteraction.serverInfo = info({ sharesNotCounted: 2 });
    render(StorageSpace);

    expect(screen.getByTestId('storage-space').title).toContain('storage_shares_not_counted');
  });
});
