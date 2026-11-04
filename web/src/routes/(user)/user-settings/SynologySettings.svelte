<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    bindSynologyAccount,
    getSynologyAccount,
    SynologyErrorReason,
    syncSynologyAccount,
    testSynologyAccount,
    unbindSynologyAccount,
    updateSynologySyncSchedule,
    type SynologyAccountResponseDto,
    type SynologyAccountTestResponseDto,
  } from '@immich/sdk';
  import {
    Alert,
    Button,
    Field,
    Input,
    LoadingSpinner,
    modalManager,
    PasswordInput,
    Switch,
    Text,
    toastManager,
  } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  let account = $state<SynologyAccountResponseDto>();
  let loadError = $state(false);
  let editing = $state(false);
  let busy = $state(false);

  let url = $state('');
  let name = $state('');
  let password = $state('');
  let verifyCertificate = $state(true);
  let otpCode = $state('');
  let needsOtp = $state(false);
  let failure = $state<{ reason?: SynologyErrorReason; message?: string }>();

  let autoSync = $state(true);
  let syncTime = $state('03:00');
  let syncing = $state(false);

  const hasScheme = /^[a-z][\d+.a-z-]*:\/\//i;

  /** the origin the server keeps for an address: HTTPS without a scheme, and no path */
  const toOrigin = (value: string) => {
    const text = value.trim();
    try {
      const parsed = new URL(hasScheme.test(text) ? text : `https://${text}`);
      return parsed.origin;
    } catch {
      return text;
    }
  };

  /** the address and account stay, so the password in the Keychain can be kept */
  const keepsPassword = $derived(
    !!account?.bound && toOrigin(url) === account.url && name.trim().toLowerCase() === account.account?.toLowerCase(),
  );
  const canSubmit = $derived(
    !!url.trim() && !!name.trim() && (!!password || keepsPassword) && (!needsOtp || /^\d{6,8}$/.test(otpCode.trim())),
  );

  const scheduleChanged = $derived(
    !!account?.bound && (autoSync !== (account.autoSync ?? true) || syncTime !== (account.syncTime ?? '03:00')),
  );
  const validTime = $derived(/^([01]\d|2[0-3]):[0-5]\d$/.test(syncTime));

  const resetSchedule = () => {
    autoSync = account?.autoSync ?? true;
    syncTime = account?.syncTime ?? '03:00';
  };

  // while a sync waits or runs, what it did is read again every few seconds
  $effect(() => {
    if (!account?.syncPending) {
      return;
    }

    const timer = setInterval(() => {
      getSynologyAccount()
        .then((value) => (account = value))
        .catch(() => {
          // tried again next time
        });
    }, 3000);
    return () => clearInterval(timer);
  });

  const reasonText = (reason?: SynologyErrorReason) => $t(`synology_error_${reason ?? SynologyErrorReason.Other}`);

  const formatTime = (value?: string) =>
    value ? DateTime.fromISO(value, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED) : '';

  const startEditing = () => {
    url = account?.url ?? '';
    name = account?.account ?? '';
    verifyCertificate = account?.verifyCertificate ?? true;
    password = '';
    otpCode = '';
    needsOtp = false;
    failure = undefined;
    editing = true;
  };

  onMount(async () => {
    try {
      account = await getSynologyAccount();
      resetSchedule();
      if (!account.bound) {
        startEditing();
      }
    } catch (error) {
      loadError = true;
      handleError(error, $t('errors.unable_to_load_synology_account'));
    }
  });

  const onResult = (result: SynologyAccountTestResponseDto, successMessage: string) => {
    account = result.account;
    if (result.success) {
      resetSchedule();
      failure = undefined;
      needsOtp = false;
      editing = false;
      password = '';
      otpCode = '';
      toastManager.primary(successMessage);
      return;
    }

    failure = { reason: result.errorReason, message: result.message };
    if (result.errorReason === SynologyErrorReason.OtpRequired || result.errorReason === SynologyErrorReason.OtpWrong) {
      needsOtp = true;
      otpCode = '';
    }
  };

  const onsubmit = async (event: Event) => {
    event.preventDefault();
    if (!canSubmit || busy) {
      return;
    }

    busy = true;
    try {
      const result = await bindSynologyAccount({
        synologyAccountBindDto: {
          url: url.trim(),
          account: name.trim(),
          password: password || undefined,
          verifyCertificate,
          otpCode: needsOtp ? otpCode.trim() : undefined,
        },
      });
      onResult(
        result,
        $t('synology_account_bound', { values: { count: result.albumCount ?? result.account.albumCount ?? 0 } }),
      );
    } catch (error) {
      handleError(error, $t('errors.unable_to_bind_synology_account'));
    } finally {
      busy = false;
    }
  };

  const handleTest = async () => {
    busy = true;
    try {
      const result = await testSynologyAccount();
      onResult(result, $t('synology_account_test_ok', { values: { count: result.albumCount ?? 0 } }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_test_synology_account'));
    } finally {
      busy = false;
    }
  };

  const handleSync = async () => {
    syncing = true;
    try {
      account = await syncSynologyAccount();
      toastManager.primary($t('synology_sync_queued'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_sync_synology_albums'));
    } finally {
      syncing = false;
    }
  };

  const handleSaveSchedule = async () => {
    busy = true;
    try {
      account = await updateSynologySyncSchedule({ synologySyncScheduleDto: { autoSync, syncTime } });
      resetSchedule();
      toastManager.primary($t('synology_sync_schedule_saved'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_synology_schedule'));
    } finally {
      busy = false;
    }
  };

  const handleUnbind = async () => {
    const confirmed = await modalManager.showDialog({
      prompt: $t('synology_account_unbind_prompt'),
      confirmText: $t('synology_account_unbind'),
    });
    if (!confirmed) {
      return;
    }

    busy = true;
    try {
      await unbindSynologyAccount();
      account = { bound: false };
      startEditing();
      toastManager.primary($t('synology_account_unbound'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_unbind_synology_account'));
    } finally {
      busy = false;
    }
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }} class="ms-4 mt-4 flex flex-col gap-4">
    <Text size="small">{$t('synology_account_description')}</Text>

    {#if !account && !loadError}
      <div class="flex justify-center"><LoadingSpinner /></div>
    {:else if account}
      {#if account.bound && !editing}
        <div class="flex flex-col gap-1" data-testid="synology-account">
          <Text fontWeight="medium">{account.account} · {account.url}</Text>
          {#if account.checkedAt}
            <Text size="small" color="muted">
              {$t('synology_account_checked', {
                values: { time: formatTime(account.checkedAt), count: account.albumCount ?? 0 },
              })}
            </Text>
          {/if}
          {#if !account.verifyCertificate}
            <Text size="small" color="muted">{$t('synology_certificate_not_checked')}</Text>
          {/if}
        </div>

        {#if account.errorReason}
          <Alert color="danger" size="small" title={reasonText(account.errorReason)}>
            {#if account.message}<Text size="tiny">{account.message}</Text>{/if}
          </Alert>
        {/if}

        <div class="flex flex-wrap justify-end gap-2">
          <Button shape="round" size="small" variant="outline" color="danger" disabled={busy} onclick={handleUnbind}>
            {$t('synology_account_unbind')}
          </Button>
          <Button shape="round" size="small" variant="outline" disabled={busy} onclick={startEditing}>
            {$t('edit')}
          </Button>
          <Button shape="round" size="small" loading={busy} disabled={busy} onclick={handleTest}>
            {$t('synology_account_test')}
          </Button>
        </div>

        <div class="flex flex-col gap-3 border-t border-gray-200 pt-4 dark:border-gray-700" data-testid="synology-sync">
          <Text fontWeight="medium">{$t('synology_sync')}</Text>
          <Text size="small" color="muted">{$t('synology_sync_description')}</Text>

          <Field label={$t('synology_sync_daily')} description={$t('synology_sync_daily_description')}>
            <Switch bind:checked={autoSync} disabled={busy} />
          </Field>
          {#if autoSync}
            <Field label={$t('synology_sync_time')}>
              <Input type="time" bind:value={syncTime} disabled={busy} class="max-w-40" />
            </Field>
          {/if}

          {#if scheduleChanged}
            <div class="flex flex-wrap justify-end gap-2">
              <Button shape="round" size="small" variant="outline" disabled={busy} onclick={resetSchedule}>
                {$t('cancel')}
              </Button>
              <Button
                shape="round"
                size="small"
                loading={busy}
                disabled={busy || (autoSync && !validTime)}
                onclick={handleSaveSchedule}
              >
                {$t('save')}
              </Button>
            </div>
          {:else if account.autoSync && account.nextSyncAt}
            <Text size="small" color="muted">
              {$t('synology_sync_next', { values: { time: formatTime(account.nextSyncAt) } })}
            </Text>
          {/if}

          {#if account.lastSync}
            {@const report = account.lastSync}
            <div class="flex flex-col gap-1" data-testid="synology-sync-report">
              <Text size="small">{$t('synology_sync_last', { values: { time: formatTime(report.finishedAt) } })}</Text>
              {#if report.success}
                <Text size="small" color="muted">
                  {$t('synology_sync_albums', {
                    values: {
                      count: report.albums,
                      created: report.albumsCreated,
                      updated: report.albumsUpdated,
                      removed: report.albumsRemoved,
                    },
                  })}
                </Text>
                <Text size="small" color="muted">
                  {$t('synology_sync_photos', {
                    values: {
                      matched: report.matched,
                      items: report.items,
                      added: report.added,
                      removed: report.removed,
                    },
                  })}
                </Text>
                {#if report.albumsEmpty > 0}
                  <Text size="small" color="muted">
                    {$t('synology_sync_empty', { values: { count: report.albumsEmpty } })}
                  </Text>
                {/if}
                {#if report.others > 0}
                  <Text size="small" color="muted">
                    {$t('synology_sync_others', { values: { count: report.others } })}
                  </Text>
                {/if}
                {#if report.albumsFailed > 0}
                  <Alert color="warning" size="small">
                    <Text size="small"
                      >{$t('synology_sync_failed_albums', { values: { count: report.albumsFailed } })}</Text
                    >
                  </Alert>
                {/if}
                {#if report.unmatchedPaths.length > 0}
                  <details class="text-sm">
                    <summary class="cursor-pointer">
                      {$t('synology_sync_unmatched')} ({report.items - report.matched})
                    </summary>
                    <ul class="ms-4 mt-1 font-mono text-xs break-all">
                      {#each report.unmatchedPaths as path (path)}
                        <li>{path}</li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              {:else}
                <Alert color="danger" size="small" title={reasonText(report.errorReason)}>
                  {#if report.message}<Text size="tiny">{report.message}</Text>{/if}
                </Alert>
              {/if}
            </div>
          {/if}

          <div class="flex justify-end">
            <Button
              shape="round"
              size="small"
              loading={syncing || account.syncPending}
              disabled={busy || syncing || account.syncPending}
              onclick={handleSync}
            >
              {account.syncPending ? $t('synology_sync_pending') : $t('synology_sync_now')}
            </Button>
          </div>
        </div>
      {:else}
        <form autocomplete="off" {onsubmit} class="flex flex-col gap-4">
          <Field label={$t('synology_address')} description={$t('synology_address_description')} required>
            <Input bind:value={url} placeholder="https://nas.example.com:5001" disabled={busy} />
          </Field>
          <Field label={$t('synology_account_name')} required>
            <Input bind:value={name} autocomplete="off" disabled={busy} />
          </Field>
          <Field
            label={$t('password')}
            description={keepsPassword ? $t('synology_password_keep') : $t('synology_password_description')}
            required={!keepsPassword}
          >
            <PasswordInput bind:value={password} autocomplete="new-password" disabled={busy} />
          </Field>
          <Field label={$t('synology_verify_certificate')} description={$t('synology_verify_certificate_description')}>
            <Switch bind:checked={verifyCertificate} disabled={busy} />
          </Field>
          {#if needsOtp}
            <Field label={$t('synology_otp_code')} description={$t('synology_otp_code_description')} required>
              <Input bind:value={otpCode} inputmode="numeric" autocomplete="one-time-code" disabled={busy} />
            </Field>
          {/if}

          {#if failure}
            <Alert color="danger" size="small" title={reasonText(failure.reason)}>
              {#if failure.message}<Text size="tiny">{failure.message}</Text>{/if}
            </Alert>
          {/if}

          <div class="flex flex-wrap justify-end gap-2">
            {#if account.bound}
              <Button shape="round" size="small" variant="outline" disabled={busy} onclick={() => (editing = false)}>
                {$t('cancel')}
              </Button>
            {/if}
            <Button shape="round" type="submit" size="small" loading={busy} disabled={busy || !canSubmit}>
              {$t('synology_account_bind')}
            </Button>
          </div>
        </form>
      {/if}
    {/if}
  </div>
</section>
