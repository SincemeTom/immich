<script lang="ts">
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getNetworkShares, NetworkShareStatus, type NetworkShareResponseDto } from '@immich/sdk';
  import { Button, Text } from '@immich/ui';
  import { mdiNas } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    onPick: (path: string) => void;
  };

  const { onPick }: Props = $props();

  let shares = $state<NetworkShareResponseDto[]>([]);

  onMount(async () => {
    if (!featureFlagsManager.value.networkShares) {
      return;
    }
    try {
      const all = await getNetworkShares();
      shares = all.filter((share) => share.status === NetworkShareStatus.Mounted);
    } catch {
      // the path can still be typed in
    }
  });
</script>

{#if shares.length > 0}
  <div class="mt-2 flex flex-wrap items-center gap-2">
    <Text size="small">{$t('network_share_use')}</Text>
    {#each shares as share (share.id)}
      <Button
        size="tiny"
        variant="outline"
        leadingIcon={mdiNas}
        title={share.mountPath}
        onclick={() => onPick(share.mountPath)}
      >
        {share.name}
      </Button>
    {/each}
  </div>
{/if}
