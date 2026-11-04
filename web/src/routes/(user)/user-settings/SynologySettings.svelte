<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    bindSynologyAccount,
    getSynologyAccount,
    SynologyErrorReason,
    testSynologyAccount,
    unbindSynologyAccount,
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
