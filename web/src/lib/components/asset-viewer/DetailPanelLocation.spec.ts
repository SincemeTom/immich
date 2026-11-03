import { clearInferredLocation, getAssetInfo } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import '@testing-library/jest-dom';
import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelLocation from './DetailPanelLocation.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  clearInferredLocation: vi.fn(),
  getAssetInfo: vi.fn(),
}));

const minhang = {
  city: '上海市 闵行区 江川路街道',
  state: '上海市',
  country: '中国',
  latitude: 31.02,
  longitude: 121.4,
};

describe('DetailPanelLocation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('marks an inferred location, and lets its owner clear it', async () => {
    const user = userEvent.setup();
    const asset = assetFactory.build({ id: 'asset-1', exifInfo: { ...minhang, locationInferred: true } });
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(true);
    vi.mocked(getAssetInfo).mockResolvedValue(assetFactory.build({ id: 'asset-1', exifInfo: {} }));

    renderWithTooltips(DetailPanelLocation, { asset, isOwner: true });

    expect(screen.getByText('location_inferred')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'location_inferred_clear' }));

    expect(modalManager.showDialog).toHaveBeenCalled();
    expect(clearInferredLocation).toHaveBeenCalledWith({ id: 'asset-1' });
    expect(getAssetInfo).toHaveBeenCalledWith({ id: 'asset-1' });
    expect(screen.queryByText('location_inferred')).not.toBeInTheDocument();
  });

  it('does not clear it unless confirmed', async () => {
    const user = userEvent.setup();
    const asset = assetFactory.build({ exifInfo: { ...minhang, locationInferred: true } });
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(false);

    renderWithTooltips(DetailPanelLocation, { asset, isOwner: true });
    await user.click(screen.getByRole('button', { name: 'location_inferred_clear' }));

    expect(clearInferredLocation).not.toHaveBeenCalled();
  });

  it('marks it for others too, without the button', () => {
    const asset = assetFactory.build({ exifInfo: { ...minhang, locationInferred: true } });

    renderWithTooltips(DetailPanelLocation, { asset, isOwner: false });

    expect(screen.getByText('location_inferred')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'location_inferred_clear' })).not.toBeInTheDocument();
  });

  it('does not mark a location of its own', () => {
    const asset = assetFactory.build({ exifInfo: minhang });

    renderWithTooltips(DetailPanelLocation, { asset, isOwner: true });

    expect(screen.getByText('上海市 闵行区 江川路街道')).toBeInTheDocument();
    expect(screen.queryByText('location_inferred')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'location_inferred_clear' })).not.toBeInTheDocument();
  });
});
