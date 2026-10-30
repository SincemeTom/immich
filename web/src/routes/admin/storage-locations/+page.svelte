<script lang="ts">
  import { invalidate } from '$app/navigation';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import StorageLocationModal from '$lib/modals/StorageLocationModal.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { Route } from '$lib/route';
  import { asQueueItem } from '$lib/services/queue.service';
  import { getStorageLocationTitle } from '$lib/services/storage-location.service';
  import type { StorageLocationItemDto } from '@immich/sdk';
  import {
    Alert,
    Badge,
    Button,
    Container,
    Heading,
    Link,
    modalManager,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { mdiPencilOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  const locations = $derived(data.locations);
  const refresh = () => invalidate('app:storage-locations');
  const pausedQueues = $derived(locations.pausedQueues.map((name) => asQueueItem($t, { name }).title).join(', '));

  const getStatus = (item: StorageLocationItemDto) => {
    if (!item.available) {
      return { color: 'danger' as const, text: $t('storage_location_status_unavailable') };
    }
    if (item.migration || item.pendingFrom.length > 0) {
      return { color: 'warning' as const, text: $t('storage_location_status_moving') };
    }
    return { color: 'success' as const, text: $t('storage_location_status_available') };
  };

  const edit = (item: StorageLocationItemDto) => modalManager.show(StorageLocationModal, { item, shares: data.shares });

  // the server checks the locations every minute, and moves files in the background; this shows it
  onMount(() => {
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  });

  const classes = {
    column1: 'w-2/12',
    column2: 'w-5/12',
    column3: 'w-3/12',
    column4: 'w-2/12 flex justify-end',
  };
</script>

<OnEvents onStorageLocationUpdate={refresh} />

{#snippet rows(items: StorageLocationItemDto[])}
  <Table striped size="small" spacing="small">
    <TableHeader>
      <TableHeading class={classes.column1}>{$t('name')}</TableHeading>
      <TableHeading class={classes.column2}>{$t('storage_location_where')}</TableHeading>
      <TableHeading class={classes.column3}>{$t('status')}</TableHeading>
      <TableHeading class={classes.column4}></TableHeading>
    </TableHeader>
    <TableBody>
      {#each items as item (item.folder ?? item.userId)}
        {@const status = getStatus(item)}
        <TableRow>
          <TableCell class={classes.column1}>
            <Stack gap={1}>
              <Text>{getStorageLocationTitle($t, item)}</Text>
              {#if item.userId && item.userName}
                <Text size="tiny" class="opacity-75">{item.userEmail}</Text>
              {/if}
            </Stack>
          </TableCell>
          <TableCell class={classes.column2}>
            <Stack gap={1}>
              <Text size="small">
                {item.location ? `${item.location.shareName} / ${item.location.path}` : $t('storage_location_local')}
              </Text>
              <Text size="tiny" class="font-mono break-all opacity-75">{item.absolutePath}</Text>
            </Stack>
          </TableCell>
          <TableCell class={classes.column3}>
            <Stack gap={1}>
              <Badge size="small" color={status.color}>{status.text}</Badge>
              {#if item.message}
                <Text size="tiny">{item.message}</Text>
              {/if}
              {#if item.migration}
                <Text size="tiny">
                  {$t('storage_location_moving', {
                    values: { moved: item.migration.moved, total: item.migration.moved + item.migration.remaining },
                  })}
                  {item.migration.failed > 0
                    ? $t('storage_location_moving_failed', { values: { count: item.migration.failed } })
                    : ''}
                </Text>
              {:else if item.pendingFrom.length > 0}
                <Text size="tiny" class="break-all">
                  {$t('storage_location_pending', { values: { path: item.pendingFrom.join(', ') } })}
                </Text>
              {/if}
            </Stack>
          </TableCell>
          <TableCell class={classes.column4}>
            <Button
              size="small"
              variant="ghost"
              leadingIcon={mdiPencilOutline}
              disabled={!!item.userId && !locations.storageTemplateEnabled && !item.location}
              onclick={() => edit(item)}
            >
              {$t('edit')}
            </Button>
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/snippet}

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]}>
  <Container size="large" center class="my-4">
    <div class="flex flex-col gap-6" in:fade={{ duration: 500 }}>
      <Alert color="info" title={$t('storage_locations_title')}>
        <Text size="small">{$t('storage_locations_description')}</Text>
      </Alert>

      {#if locations.pausedQueues.length > 0}
        <Alert color="warning" title={$t('storage_locations_paused_title')}>
          <Text size="small">{$t('storage_locations_paused', { values: { queues: pausedQueues } })}</Text>
        </Alert>
      {/if}

      <Stack gap={2}>
        <Heading size="tiny">{$t('storage_locations_generated')}</Heading>
        <Text size="small" class="opacity-75">{$t('storage_locations_generated_description')}</Text>
        {@render rows(locations.folders)}
      </Stack>

      <Stack gap={2}>
        <Heading size="tiny">{$t('storage_locations_originals')}</Heading>
        <Text size="small" class="opacity-75">{$t('storage_locations_originals_description')}</Text>
        {#if !locations.storageTemplateEnabled}
          <Alert color="warning">
            <Text size="small">
              {$t('storage_locations_template_off')}
              <Link href={Route.systemSettings({ isOpen: OpenQueryParam.STORAGE_TEMPLATE })}
                >{$t('admin.storage_template_settings')}</Link
              >
            </Text>
          </Alert>
        {/if}
        {@render rows(locations.users)}
      </Stack>
    </div>
  </Container>
</AdminPageLayout>
