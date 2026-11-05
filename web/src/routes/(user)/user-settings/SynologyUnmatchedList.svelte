<script lang="ts">
  import { downloadBlob } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getSynologyUnmatched, SynologyUnmatchedReason, type SynologyUnmatchedDto } from '@immich/sdk';
  import { Button, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    /** how many albums and photos the last sync did not match */
    count: number;
  };

  let { count }: Props = $props();

  /** the photos shown at most: there may be thousands, and the download has them all */
  const SHOWN = 500;
  const albumReasons = new Set<SynologyUnmatchedReason>([
    SynologyUnmatchedReason.AlbumEmpty,
    SynologyUnmatchedReason.AlbumFailed,
  ]);

  type Group = { id: number; name: string; album?: SynologyUnmatchedReason; photos: SynologyUnmatchedDto[] };

  let items = $state<SynologyUnmatchedDto[]>();
  let open = $state(false);
  let loading = $state(false);

  const groups = $derived.by(() => {
    const result: Group[] = [];
    const byId: Record<number, Group> = {};
    let shown = 0;
    for (const item of items ?? []) {
      let group = byId[item.albumId];
      if (!group) {
        group = { id: item.albumId, name: item.albumName, photos: [] };
        byId[item.albumId] = group;
        result.push(group);
      }

      if (albumReasons.has(item.reason)) {
        group.album = item.reason;
      } else if (shown < SHOWN) {
        group.photos.push(item);
        shown++;
      }
    }
    return result.filter(({ album, photos }) => album || photos.length > 0);
  });
  const photoCount = $derived((items ?? []).filter(({ reason }) => !albumReasons.has(reason)).length);

  const load = async () => {
    if (items) {
      return items;
    }

    loading = true;
    try {
      items = await getSynologyUnmatched();
      return items;
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_synology_unmatched'));
    } finally {
      loading = false;
    }
  };

  const reasonText = (reason: SynologyUnmatchedReason) => $t(`synology_unmatched_${reason}`);
  const whoseText = (mine: boolean) => (mine ? $t('synology_unmatched_mine') : $t('synology_unmatched_others'));

  /** a CSV cell: quoted when needed, and not taken for a formula by a spreadsheet */
  const cell = (value: string) => {
    const text = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const toCsv = (rows: SynologyUnmatchedDto[]) => {
    const lines = [
      [$t('album'), $t('synology_unmatched_reason'), $t('owner'), $t('path')],
      ...rows.map(({ albumName, reason, mine, path }) => [
        albumName,
        reasonText(reason),
        albumReasons.has(reason) ? '' : whoseText(mine),
        path ?? '',
      ]),
    ];
    // with a BOM, spreadsheets read it as UTF-8
    return '\u{FEFF}' + lines.map((line) => line.map((value) => cell(value)).join(',')).join('\r\n') + '\r\n';
  };

  const handleToggle = async () => {
    if (open) {
      open = false;
      return;
    }

    open = !!(await load());
  };

  const handleDownload = async () => {
    const rows = await load();
    if (rows) {
      downloadBlob(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), 'synology-unmatched.csv');
    }
  };
</script>

<div class="flex flex-col gap-2" data-testid="synology-unmatched">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Text size="small">{$t('synology_sync_unmatched', { values: { count } })}</Text>
    <div class="flex gap-2">
      <Button shape="round" size="small" variant="outline" {loading} disabled={loading} onclick={handleToggle}>
        {open ? $t('synology_sync_unmatched_hide') : $t('synology_sync_unmatched_show')}
      </Button>
      <Button shape="round" size="small" variant="outline" disabled={loading} onclick={handleDownload}>
        {$t('synology_sync_unmatched_download')}
      </Button>
    </div>
  </div>

  {#if open && items}
    <div
      class="flex max-h-96 flex-col gap-3 overflow-y-auto rounded-lg border border-gray-200 p-3 dark:border-gray-700"
      data-testid="synology-unmatched-list"
    >
      {#each groups as group (group.id)}
        <div class="flex flex-col gap-1">
          <Text size="small" fontWeight="medium">{group.name}</Text>
          {#if group.album}
            <Text size="tiny" color="muted">{reasonText(group.album)}</Text>
          {/if}
          {#if group.photos.length > 0}
            <ul class="ms-4 flex flex-col gap-0.5 text-xs">
              {#each group.photos as photo, index (index)}
                <li class="break-all">
                  <span class="font-mono">{photo.path}</span>
                  <span class="text-gray-500 dark:text-gray-400">
                    · {reasonText(photo.reason)}{#if !photo.mine}
                      · {whoseText(false)}{/if}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
      {#if photoCount > SHOWN}
        <Text size="tiny" color="muted">{$t('synology_sync_unmatched_more', { values: { count: SHOWN } })}</Text>
      {/if}
    </div>
  {/if}
</div>
