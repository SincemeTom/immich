<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { requestServerInfo } from '$lib/utils/auth';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { LoadingSpinner, Meter } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const info = $derived(userInteraction.serverInfo);
  const quota = $derived(info?.quotaSizeInBytes ?? null);
  // what the user's photos take, uploaded and of their external libraries; of the quota, or of the server's storage
  let availableBytes = $derived((quota ?? info?.diskSizeRaw) || 0);
  let usedBytes = $derived(info?.diskUseRaw || 0);
  const format = (bytes: number, precision?: number) => getByteUnitString(bytes, $locale, precision);
  const details = $derived.by(() => {
    if (!info) {
      return '';
    }

    const lines = [
      $t('storage_usage_detail', {
        values: { uploads: format(info.usageUploads, 3), external: format(info.usageExternal, 3) },
      }),
    ];
    if (quota !== null) {
      lines.push($t('storage_quota_counts_uploads'));
    }
    if (info.sharesNotCounted > 0) {
      lines.push($t('storage_shares_not_counted', { values: { count: info.sharesNotCounted } }));
    }
    return lines.join('\n');
  });

  const thresholds = [
    { from: 0.8, className: 'bg-warning' },
    { from: 0.95, className: 'bg-danger' },
  ];

  onMount(async () => {
    if (userInteraction.serverInfo && authManager.authenticated) {
      return;
    }
    await requestServerInfo();
  });
</script>

<div
  class="ms-4 min-w-52 rounded-lg bg-light-100 p-4 text-sm"
  title={[
    $t('storage_usage', { values: { used: format(usedBytes, 3), available: format(availableBytes, 3) } }),
    details,
  ]
    .filter(Boolean)
    .join('\n')}
  data-testid="storage-space"
>
  {#if info}
    <Meter
      size="tiny"
      class="bg-light-200"
      containerClass="gap-2 leading-6"
      label={$t('storage')}
      valueLabel={$t('storage_usage', {
        values: { used: format(usedBytes), available: format(availableBytes) },
      })}
      value={availableBytes > 0 ? Math.min(usedBytes / availableBytes, 1) : 0}
      {thresholds}
    />
  {:else}
    <p class="mb-4 font-medium text-immich-dark-gray dark:text-white">{$t('storage')}</p>
    <LoadingSpinner />
  {/if}
</div>
