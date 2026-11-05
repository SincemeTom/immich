import { StorageVolumeKind, StorageVolumeStatus, type ServerStorageDetailsResponseDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import ServerStorageDetails from './ServerStorageDetails.svelte';

const GiB = 1024 ** 3;
const details: ServerStorageDetailsResponseDto = {
  totalBytes: 9000 * GiB,
  usedBytes: 4000 * GiB,
  availableBytes: 5000 * GiB,
  includesNetworkShares: true,
  notCounted: 1,
  checkedAt: '2026-11-04T12:00:00.000Z',
  volumes: [
    {
      id: 'local',
      kind: StorageVolumeKind.Local,
      name: '',
      source: '/Users/me/Immich',
      path: '/Users/me/Immich',
      status: StorageVolumeStatus.Counted,
      totalBytes: 1000 * GiB,
      usedBytes: 500 * GiB,
      availableBytes: 500 * GiB,
    },
    {
      id: 'a',
      kind: StorageVolumeKind.NetworkShare,
      name: 'Photos',
      source: 'nas:/volume1/photo',
      path: '/mounts/Photos',
      status: StorageVolumeStatus.Counted,
      totalBytes: 8000 * GiB,
      usedBytes: 3500 * GiB,
      availableBytes: 4500 * GiB,
    },
    {
      id: 'b',
      kind: StorageVolumeKind.NetworkShare,
      name: 'Homes',
      source: 'nas:/volume1/homes',
      path: '/mounts/Homes',
      status: StorageVolumeStatus.SameVolume,
      sameAs: 'a',
      totalBytes: 8000 * GiB,
      usedBytes: 3500 * GiB,
      availableBytes: 4500 * GiB,
    },
    {
      id: 'c',
      kind: StorageVolumeKind.NetworkShare,
      name: 'Away',
      source: 'nas2:/x',
      path: '/mounts/Away',
      status: StorageVolumeStatus.Offline,
    },
  ],
};

describe('ServerStorageDetails component', () => {
  it("should show the server's storage, and each volume", () => {
    render(ServerStorageDetails, { details });

    const panel = screen.getByTestId('server-storage-details');
    expect(panel).toHaveTextContent('server_storage_total');
    expect(panel).toHaveTextContent('server_storage_local');
    expect(panel).toHaveTextContent('nas:/volume1/photo');
    expect(panel).toHaveTextContent('server_storage_not_counted');
    expect(panel).toHaveTextContent('server_storage_checked_at');
    expect(panel).not.toHaveTextContent('server_storage_shares_excluded');
    expect(screen.getAllByTestId('server-storage-status').map((status) => status.textContent?.trim())).toEqual([
      'server_storage_status_counted',
      'server_storage_status_counted',
      'server_storage_status_sameVolume',
      'server_storage_status_offline',
    ]);
  });

  it('should tell when the network shares are not counted', () => {
    render(ServerStorageDetails, {
      details: {
        ...details,
        includesNetworkShares: false,
        notCounted: 0,
        volumes: details.volumes.map((volume) =>
          volume.kind === StorageVolumeKind.Local ? volume : { ...volume, status: StorageVolumeStatus.Excluded },
        ),
      },
    });

    const panel = screen.getByTestId('server-storage-details');
    expect(panel).toHaveTextContent('server_storage_shares_excluded');
    expect(panel).not.toHaveTextContent('server_storage_not_counted');
  });
});
