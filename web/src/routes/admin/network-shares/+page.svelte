<script lang="ts">
  import { invalidate } from '$app/navigation';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import NetworkShareModal from '$lib/modals/NetworkShareModal.svelte';
  import {
    getNetworkShareActions,
    getNetworkShareErrorHint,
    getNetworkSharesActions,
  } from '$lib/services/network-share.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { NetworkShareStatus, type NetworkShareResponseDto } from '@immich/sdk';
  import {
    Alert,
    Badge,
    CommandPaletteDefaultProvider,
    Container,
    ContextMenuButton,
    MenuItemType,
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
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  const shares = $derived(data.shares);
  const refresh = () => invalidate('app:network-shares');

  const { Create } = $derived(getNetworkSharesActions($t));

  const getActionsForShare = (share: NetworkShareResponseDto) => {
    const { Edit, Mount, Unmount, Delete } = getNetworkShareActions($t, share);
    return [Edit, share.enabled ? Unmount : Mount, MenuItemType.Divider, Delete];
  };

  const getStatus = (share: NetworkShareResponseDto) => {
    if (share.status === NetworkShareStatus.Mounted) {
      return { color: 'success' as const, text: $t('network_share_status_mounted') };
    }
    if (share.status === NetworkShareStatus.Unresponsive) {
      return { color: 'warning' as const, text: $t('network_share_status_unresponsive') };
    }
    if (!share.enabled) {
      return { color: 'secondary' as const, text: $t('network_share_status_unmounted') };
    }
    return { color: 'danger' as const, text: $t('network_share_status_failed') };
  };

  // the server mounts dropped shares again every minute; this shows it
  onMount(() => {
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  });

  const classes = {
    column1: 'w-3/12',
    column2: 'w-3/12',
    column3: 'w-2/12',
    column4: 'w-2/12',
    column5: 'w-1/12',
    column6: 'w-1/12 flex justify-end',
  };
</script>

<OnEvents onNetworkShareCreate={refresh} onNetworkShareUpdate={refresh} onNetworkShareDelete={refresh} />

<CommandPaletteDefaultProvider name={$t('network_shares')} actions={[Create]} />

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]} actions={[Create]}>
  <Container size="large" center class="my-4">
    <div class="flex flex-col gap-4" in:fade={{ duration: 500 }}>
      <Alert color="info" title={$t('network_share_setup_title')}>
        <Text size="small">{$t('network_share_setup_description')}</Text>
      </Alert>

      {#if shares.length > 0}
        <Table striped size="small" spacing="small">
          <TableHeader>
            <TableHeading class={classes.column1}>{$t('name')}</TableHeading>
            <TableHeading class={classes.column2}>{$t('network_share_address')}</TableHeading>
            <TableHeading class={classes.column3}>{$t('status')}</TableHeading>
            <TableHeading class={classes.column4}>{$t('storage')}</TableHeading>
            <TableHeading class={classes.column5}>{$t('external_libraries')}</TableHeading>
            <TableHeading class={classes.column6}></TableHeading>
          </TableHeader>
          <TableBody>
            {#each shares as share (share.id)}
              {@const status = getStatus(share)}
              <TableRow>
                <TableCell class={classes.column1}>
                  <Stack gap={1}>
                    <Text>{share.name}{share.readOnly ? ` (${$t('network_share_read_only_short')})` : ''}</Text>
                    <Text size="tiny" class="font-mono break-all opacity-75" title={$t('network_share_mount_path')}>
                      {share.mountPath}
                    </Text>
                  </Stack>
                </TableCell>
                <TableCell class={classes.column2}>
                  <Text size="small" class="font-mono break-all">{share.host}:{share.exportPath}</Text>
                </TableCell>
                <TableCell class={classes.column3}>
                  <Stack gap={1}>
                    <Badge size="small" color={status.color}>{status.text}</Badge>
                    {#if share.enabled && share.status !== NetworkShareStatus.Mounted && share.errorReason}
                      <Text size="tiny" title={share.message}>{getNetworkShareErrorHint($t, share.errorReason)}</Text>
                    {/if}
                  </Stack>
                </TableCell>
                <TableCell class={classes.column4}>
                  {#if share.totalBytes !== undefined && share.availableBytes !== undefined}
                    <Text size="small">
                      {$t('network_share_free', {
                        values: {
                          available: getByteUnitString(share.availableBytes, $locale),
                          total: getByteUnitString(share.totalBytes, $locale),
                        },
                      })}
                    </Text>
                  {:else}
                    -
                  {/if}
                </TableCell>
                <TableCell class={classes.column5}>
                  <Text size="small">{share.libraries.length > 0 ? share.libraries.join(', ') : '-'}</Text>
                </TableCell>
                <TableCell class={classes.column6}>
                  <ContextMenuButton color="primary" aria-label={$t('open')} items={getActionsForShare(share)} />
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {:else}
        <EmptyPlaceholder
          fullWidth
          text={$t('network_share_empty')}
          onClick={() => modalManager.show(NetworkShareModal, {})}
          class="mx-auto mt-10"
        />
      {/if}
    </div>
  </Container>
</AdminPageLayout>
