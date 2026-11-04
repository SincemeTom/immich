<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import ServerStatisticsPanel from './ServerStatisticsPanel.svelte';
  import ServerStorageDetails from './ServerStorageDetails.svelte';
  import {
    getServerStatistics,
    getStorageDetails,
    type ServerStatsResponseDto,
    type ServerStorageDetailsResponseDto,
  } from '@immich/sdk';
  import { Container } from '@immich/ui';
  import { onMount } from 'svelte';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  let stats = $state<ServerStatsResponseDto | undefined>(undefined);

  const statsPromise = $derived.by(() => {
    if (stats) {
      return Promise.resolve(stats);
    }
    return data.statsPromise;
  });

  let storage = $state<ServerStorageDetailsResponseDto | undefined>(undefined);

  const updateStatistics = async () => {
    stats = await getServerStatistics();
  };

  // what the disk and the shares hold: the shares are read by the server every minute
  const updateStorage = async () => {
    try {
      storage = await getStorageDetails();
    } catch {
      // left as it was: the statistics above still show
    }
  };

  onMount(() => {
    void updateStorage();
    const interval = setInterval(() => void updateStatistics(), 5000);
    const storageInterval = setInterval(() => void updateStorage(), 30_000);

    return () => {
      clearInterval(interval);
      clearInterval(storageInterval);
    };
  });
</script>

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]}>
  <Container size="large" center>
    <div class="flex flex-col gap-8">
      {#if storage}
        <ServerStorageDetails details={storage} />
      {/if}
      <ServerStatisticsPanel {statsPromise} users={data.users} />
    </div>
  </Container>
</AdminPageLayout>
