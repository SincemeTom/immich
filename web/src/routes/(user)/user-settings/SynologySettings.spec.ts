import {
  bindSynologyAccount,
  getSynologyAccount,
  getSynologyUnmatched,
  SynologyErrorReason,
  SynologyUnmatchedReason,
  syncSynologyAccount,
  testSynologyAccount,
  unbindSynologyAccount,
  updateSynologySyncSchedule,
  type SynologyAccountResponseDto,
  type SynologySyncReportDto,
} from '@immich/sdk';
import { modalManager } from '@immich/ui';
import '@testing-library/jest-dom';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { downloadBlob } from '$lib/utils';
import { renderWithTooltips } from '$tests/helpers';
import SynologySettings from './SynologySettings.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getSynologyAccount: vi.fn(),
  bindSynologyAccount: vi.fn(),
  testSynologyAccount: vi.fn(),
  unbindSynologyAccount: vi.fn(),
  syncSynologyAccount: vi.fn(),
  updateSynologySyncSchedule: vi.fn(),
  getSynologyUnmatched: vi.fn(),
}));

vi.mock('$lib/utils', async (original) => ({
  ...(await original<typeof import('$lib/utils')>()),
  downloadBlob: vi.fn(),
}));

const bound: SynologyAccountResponseDto = {
  bound: true,
  url: 'https://nas.example.com:5001',
  account: 'alice',
  verifyCertificate: true,
  name: 'alice',
  boundAt: '2026-11-01T00:00:00.000Z',
  checkedAt: '2026-11-01T00:00:00.000Z',
  albumCount: 49,
};

const report: SynologySyncReportDto = {
  startedAt: '2026-11-04T03:00:00.000Z',
  finishedAt: '2026-11-04T03:02:00.000Z',
  success: true,
  albums: 49,
  albumsCreated: 47,
  albumsUpdated: 0,
  albumsRemoved: 0,
  albumsEmpty: 2,
  albumsFailed: 1,
  items: 13_426,
  matched: 13_400,
  matchedByName: 120,
  others: 3049,
  othersMatched: 3044,
  othersWaiting: 5,
  ambiguous: 1,
  membersAdded: 3,
  membersUpdated: 0,
  membersRemoved: 0,
  added: 13_400,
  removed: 0,
  membersWaiting: 2,
  unmatched: 4,
};

const unmatched = [
  { albumId: 8, albumName: 'Empty', reason: SynologyUnmatchedReason.AlbumEmpty, mine: true },
  { albumId: 8, albumName: 'Empty', reason: SynologyUnmatchedReason.NotFound, path: '2024/none.jpg', mine: true },
  { albumId: 7, albumName: 'Trip', reason: SynologyUnmatchedReason.NotFound, path: '2023/Trip/gone.jpg', mine: true },
  { albumId: 7, albumName: 'Trip', reason: SynologyUnmatchedReason.OwnerWaiting, path: 'IMG_1.jpg', mine: false },
];

const scheduled: SynologyAccountResponseDto = {
  ...bound,
  autoSync: true,
  syncTime: '03:00',
  nextSyncAt: '2026-11-05T03:00:00.000Z',
  syncPending: false,
};

const inputs = () => {
  const textboxes = screen.getAllByRole('textbox') as HTMLInputElement[];
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  return { url: textboxes[0], account: textboxes[1], password, all: textboxes };
};

const bindButton = () => screen.getByRole('button', { name: 'synology_account_bind' });

describe('SynologySettings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  it('should ask for an address, account and password when none is bound', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue({ bound: false });
    vi.mocked(bindSynologyAccount).mockResolvedValue({ success: true, albumCount: 49, account: bound });
    renderWithTooltips(SynologySettings, {});

    await waitFor(() => expect(bindButton()).toBeDisabled());
    const { url, account, password } = inputs();
    await fireEvent.input(url, { target: { value: ' nas.example.com:5001 ' } });
    await fireEvent.input(account, { target: { value: 'alice' } });
    expect(bindButton()).toBeDisabled();
    await fireEvent.input(password, { target: { value: 'p@ss' } });
    expect(bindButton()).toBeEnabled();

    await fireEvent.click(bindButton());

    expect(bindSynologyAccount).toHaveBeenCalledWith({
      synologyAccountBindDto: {
        url: 'nas.example.com:5001',
        account: 'alice',
        password: 'p@ss',
        verifyCertificate: true,
        otpCode: undefined,
      },
    });
    expect(await screen.findByTestId('synology-account')).toHaveTextContent('alice · https://nas.example.com:5001');
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('should ask for the 2-step verification code when Synology wants one', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue({ bound: false });
    vi.mocked(bindSynologyAccount)
      .mockResolvedValueOnce({
        success: false,
        errorReason: SynologyErrorReason.OtpRequired,
        message: 'The NAS answered with error 403',
        account: { bound: false },
      })
      .mockResolvedValueOnce({ success: true, albumCount: 49, account: bound });
    renderWithTooltips(SynologySettings, {});

    await waitFor(() => expect(bindButton()).toBeDisabled());
    const { url, account, password } = inputs();
    await fireEvent.input(url, { target: { value: 'https://nas.example.com:5001' } });
    await fireEvent.input(account, { target: { value: 'admin' } });
    await fireEvent.input(password, { target: { value: 'pw' } });
    await fireEvent.click(bindButton());

    expect(await screen.findByText('synology_error_otpRequired')).toBeInTheDocument();
    expect(screen.getByText('The NAS answered with error 403')).toBeInTheDocument();
    const otp = inputs().all[2];
    expect(bindButton()).toBeDisabled();
    await fireEvent.input(otp, { target: { value: '123456' } });
    await fireEvent.click(bindButton());

    expect(bindSynologyAccount).toHaveBeenLastCalledWith({
      synologyAccountBindDto: expect.objectContaining({ password: 'pw', otpCode: '123456' }),
    });
    expect(await screen.findByTestId('synology-account')).toBeInTheDocument();
  });

  it('should show why binding failed, and keep the form', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue({ bound: false });
    vi.mocked(bindSynologyAccount).mockResolvedValue({
      success: false,
      errorReason: SynologyErrorReason.WrongPassword,
      account: { bound: false },
    });
    renderWithTooltips(SynologySettings, {});

    await waitFor(() => expect(bindButton()).toBeDisabled());
    const { url, account, password } = inputs();
    await fireEvent.input(url, { target: { value: 'nas' } });
    await fireEvent.input(account, { target: { value: 'alice' } });
    await fireEvent.input(password, { target: { value: 'wrong' } });
    await fireEvent.click(bindButton());

    expect(await screen.findByText('synology_error_wrongPassword')).toBeInTheDocument();
    expect(screen.queryByText('synology_otp_code')).toBeNull();
    expect(bindButton()).toBeInTheDocument();
  });

  it('should show the bound account, and test it', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(bound);
    vi.mocked(testSynologyAccount).mockResolvedValue({
      success: false,
      errorReason: SynologyErrorReason.Unreachable,
      message: 'connect ECONNREFUSED',
      account: { ...bound, errorReason: SynologyErrorReason.Unreachable, message: 'connect ECONNREFUSED' },
    });
    renderWithTooltips(SynologySettings, {});

    expect(await screen.findByTestId('synology-account')).toHaveTextContent('alice · https://nas.example.com:5001');
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'synology_account_test' }));

    expect(testSynologyAccount).toHaveBeenCalled();
    expect(await screen.findAllByText('synology_error_unreachable')).not.toHaveLength(0);
  });

  it('should keep the saved password when only the certificate check changes', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(bound);
    vi.mocked(bindSynologyAccount).mockResolvedValue({ success: true, albumCount: 49, account: bound });
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    expect(screen.getByText('synology_password_keep')).toBeInTheDocument();
    expect(bindButton()).toBeEnabled();
    await fireEvent.click(screen.getByRole('switch'));
    await fireEvent.click(bindButton());

    expect(bindSynologyAccount).toHaveBeenCalledWith({
      synologyAccountBindDto: {
        url: 'https://nas.example.com:5001',
        account: 'alice',
        password: undefined,
        verifyCertificate: false,
        otpCode: undefined,
      },
    });
  });

  it('should want the password when the address changes', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(bound);
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('button', { name: 'edit' }));
    await fireEvent.input(inputs().url, { target: { value: 'nas.example.com:5001/photo' } });
    expect(bindButton()).toBeEnabled();
    await fireEvent.input(inputs().url, { target: { value: 'other.example.com' } });

    expect(bindButton()).toBeDisabled();
    expect(screen.getByText('synology_password_description')).toBeInTheDocument();
  });

  it('should unbind after confirming', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(bound);
    vi.mocked(unbindSynologyAccount).mockResolvedValue(undefined as never);
    const dialog = vi.spyOn(modalManager, 'showDialog').mockResolvedValue(true);
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('button', { name: 'synology_account_unbind' }));

    expect(dialog).toHaveBeenCalled();
    await waitFor(() => expect(unbindSynologyAccount).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'synology_account_bind' })).toBeInTheDocument();
    expect(inputs().url.value).toBe('');
  });

  it('should not unbind when not confirmed', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(bound);
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(false);
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('button', { name: 'synology_account_unbind' }));

    expect(unbindSynologyAccount).not.toHaveBeenCalled();
    expect(screen.getByTestId('synology-account')).toBeInTheDocument();
  });

  it('should show what the last sync did', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue({ ...scheduled, lastSync: report });
    renderWithTooltips(SynologySettings, {});

    const section = await screen.findByTestId('synology-sync-report');
    expect(section).toHaveTextContent('synology_sync_albums');
    expect(section).toHaveTextContent('synology_sync_photos');
    expect(section).toHaveTextContent('synology_sync_empty');
    expect(section).toHaveTextContent('synology_sync_others');
    expect(section).toHaveTextContent('synology_sync_members');
    expect(screen.getByTestId('synology-ambiguous')).toBeInTheDocument();
    expect(screen.getByTestId('synology-waiting-members')).toBeInTheDocument();
    expect(section).toHaveTextContent('synology_sync_failed_albums');
    expect(section).toHaveTextContent('synology_sync_by_name');
    expect(section).toHaveTextContent('synology_sync_unmatched');
    expect(screen.getByText('synology_sync_next')).toBeInTheDocument();
    expect(getSynologyUnmatched).not.toHaveBeenCalled();
  });

  it('should list what the last sync did not match, by album', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue({ ...scheduled, lastSync: report });
    vi.mocked(getSynologyUnmatched).mockResolvedValue(unmatched);
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('button', { name: 'synology_sync_unmatched_show' }));

    const list = await screen.findByTestId('synology-unmatched-list');
    expect(list).toHaveTextContent('Empty');
    expect(list).toHaveTextContent('synology_unmatched_albumEmpty');
    expect(list).toHaveTextContent('2023/Trip/gone.jpg');
    expect(list).toHaveTextContent('IMG_1.jpg');
    expect(list).toHaveTextContent('synology_unmatched_others');

    await fireEvent.click(screen.getByRole('button', { name: 'synology_sync_unmatched_hide' }));
    expect(screen.queryByTestId('synology-unmatched-list')).not.toBeInTheDocument();
    expect(getSynologyUnmatched).toHaveBeenCalledTimes(1);
  });

  it('should download what the last sync did not match', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue({ ...scheduled, lastSync: report });
    vi.mocked(getSynologyUnmatched).mockResolvedValue([
      ...unmatched,
      { albumId: 9, albumName: '=Trip, "B"', reason: SynologyUnmatchedReason.NotFound, path: 'a.jpg', mine: true },
    ]);
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('button', { name: 'synology_sync_unmatched_download' }));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toBe('synology-unmatched.csv');
    const text = await blob.text();
    const lines = text
      .replace(/^\u{FEFF}/u, '')
      .trimEnd()
      .split('\r\n');
    expect(lines).toEqual([
      'album,synology_unmatched_reason,owner,path',
      'Empty,synology_unmatched_albumEmpty,,',
      'Empty,synology_unmatched_notFound,synology_unmatched_mine,2024/none.jpg',
      'Trip,synology_unmatched_notFound,synology_unmatched_mine,2023/Trip/gone.jpg',
      'Trip,synology_unmatched_ownerWaiting,synology_unmatched_others,IMG_1.jpg',
      `"'=Trip, ""B""",synology_unmatched_notFound,synology_unmatched_mine,a.jpg`,
    ]);
  });

  it('should show why the last sync failed', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue({
      ...scheduled,
      lastSync: { ...report, success: false, errorReason: SynologyErrorReason.WrongPassword, unmatched: 0 },
    });
    renderWithTooltips(SynologySettings, {});

    const section = await screen.findByTestId('synology-sync-report');
    expect(section).toHaveTextContent('synology_error_wrongPassword');
    expect(section).not.toHaveTextContent('synology_sync_photos');
  });

  it('should sync now, and say it is syncing', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(scheduled);
    vi.mocked(syncSynologyAccount).mockResolvedValue({ ...scheduled, syncPending: true });
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('button', { name: 'synology_sync_now' }));

    expect(syncSynologyAccount).toHaveBeenCalled();
    const button = await screen.findByRole('button', { name: /synology_sync_pending/ });
    expect(button).toBeDisabled();
  });

  it('should save the time of day, once changed', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(scheduled);
    vi.mocked(updateSynologySyncSchedule).mockResolvedValue({ ...scheduled, syncTime: '22:30' });
    renderWithTooltips(SynologySettings, {});

    await screen.findByTestId('synology-sync');
    expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
    await fireEvent.input(document.querySelector('input[type="time"]')!, { target: { value: '22:30' } });
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(updateSynologySyncSchedule).toHaveBeenCalledWith({
      synologySyncScheduleDto: { autoSync: true, syncTime: '22:30' },
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'save' })).toBeNull());
  });

  it('should turn the daily sync off', async () => {
    vi.mocked(getSynologyAccount).mockResolvedValue(scheduled);
    vi.mocked(updateSynologySyncSchedule).mockResolvedValue({ ...scheduled, autoSync: false, nextSyncAt: undefined });
    renderWithTooltips(SynologySettings, {});

    await fireEvent.click(await screen.findByRole('switch'));
    expect(document.querySelector('input[type="time"]')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    expect(updateSynologySyncSchedule).toHaveBeenCalledWith({
      synologySyncScheduleDto: { autoSync: false, syncTime: '03:00' },
    });
    await waitFor(() => expect(screen.queryByText('synology_sync_next')).toBeNull());
  });
});
