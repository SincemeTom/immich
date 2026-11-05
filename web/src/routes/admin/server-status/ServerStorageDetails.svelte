<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    StorageVolumeKind,
    StorageVolumeStatus,
    type ServerStorageDetailsResponseDto,
    type StorageVolumeDto,
  } from '@immich/sdk';
  import {
    FormatBytes,
    Meter,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    details: ServerStorageDetailsResponseDto;
  };

  const { details }: Props = $props();

  const thresholds = [
    { from: 0.8, className: 'bg-warning' },
    { from: 0.95, className: 'bg-danger' },
  ];

  const format = (bytes: number) => getByteUnitString(bytes, $locale, 1);
  const nameOf = (volume: StorageVolumeDto) =>
    volume.kind === StorageVolumeKind.Local ? $t('server_storage_local') : volume.name;
  const statusOf = (volume: StorageVolumeDto) => {
    if (volume.status === StorageVolumeStatus.SameVolume) {
      const same = details.volumes.find(({ id }) => id === volume.sameAs);
      return $t('server_storage_status_sameVolume', { values: { name: same ? nameOf(same) : '' } });
    }
    return $t(`server_storage_status_${volume.status}`);
  };
  const checkedAt = $derived(
    details.checkedAt
      ? new Date(details.checkedAt).toLocaleTimeString($locale, { hour: '2-digit', minute: '2-digit' })
      : undefined,
  );
</script>

<div class="flex flex-col gap-2" data-testid="server-storage-details">
  <Text fontWeight="medium">{$t('server_storage')}</Text>
  <Meter
    size="small"
    label={$t('server_storage_total')}
    valueLabel={$t('server_storage_summary', {
      values: {
        used: format(details.usedBytes),
        total: format(details.totalBytes),
        available: format(details.availableBytes),
      },
    })}
    value={details.totalBytes > 0 ? details.usedBytes / details.totalBytes : 0}
    {thresholds}
  />
  {#if details.notCounted > 0}
    <Text size="small" color="warning">
      {$t('server_storage_not_counted', { values: { count: details.notCounted } })}
    </Text>
  {/if}
  {#if !details.includesNetworkShares && details.volumes.length > 1}
    <Text size="small" color="muted">{$t('server_storage_shares_excluded')}</Text>
  {/if}

  <Table striped size="small">
    <TableHeader>
      <TableHeading class="w-1/4">{$t('name')}</TableHeading>
      <TableHeading class="w-1/4">{$t('server_storage_source')}</TableHeading>
      <TableHeading class="w-1/4">{$t('usage')}</TableHeading>
      <TableHeading class="w-1/4">{$t('status')}</TableHeading>
    </TableHeader>
    <TableBody>
      {#each details.volumes as volume (volume.id)}
        <TableRow>
          <TableCell class="w-1/4">{nameOf(volume)}</TableCell>
          <TableCell class="w-1/4 break-all" title={volume.path}>
            <span class="font-mono text-xs">{volume.source}</span>
          </TableCell>
          <TableCell class="w-1/4">
            {#if volume.totalBytes !== undefined && volume.usedBytes !== undefined}
              <FormatBytes bytes={volume.usedBytes} precision={1} /> /
              <FormatBytes bytes={volume.totalBytes} precision={1} />
              {#if volume.availableBytes !== undefined}
                <span class="text-gray-500 dark:text-gray-400">
                  ({$t('server_storage_available')}
                  <FormatBytes bytes={volume.availableBytes} precision={1} />)
                </span>
              {/if}
            {:else}
              -
            {/if}
          </TableCell>
          <TableCell class="w-1/4">
            <span
              class={volume.status === StorageVolumeStatus.Offline ? 'text-warning' : ''}
              data-testid="server-storage-status"
            >
              {statusOf(volume)}
            </span>
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
  {#if checkedAt && details.volumes.length > 1}
    <Text size="tiny" color="muted">{$t('server_storage_checked_at', { values: { time: checkedAt } })}</Text>
  {/if}
</div>
