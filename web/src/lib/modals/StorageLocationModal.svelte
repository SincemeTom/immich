<script lang="ts">
  import { getStorageLocationTitle, handleUpdateStorageLocation } from '$lib/services/storage-location.service';
  import { NetworkShareStatus, type NetworkShareResponseDto, type StorageLocationItemDto } from '@immich/sdk';
  import { Alert, Field, FormModal, HelperText, Input, Select, Stack, Text } from '@immich/ui';
  import { mdiFolderNetworkOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    item: StorageLocationItemDto;
    shares: NetworkShareResponseDto[];
    onClose: () => void;
  };

  const { item, shares, onClose }: Props = $props();

  const LOCAL = 'local';
  let target = $state(item.location?.shareId ?? LOCAL);
  let path = $state(item.location?.path ?? item.suggestedPath);
  let saving = $state(false);

  // a share files can be written to, mounted now
  const usable = $derived(
    shares.filter(
      (share) =>
        !share.readOnly && (share.status === NetworkShareStatus.Mounted || share.id === item.location?.shareId),
    ),
  );
  const options = $derived([
    { label: $t('storage_location_local'), value: LOCAL },
    ...usable.map((share) => ({ label: `${share.name} (${share.host}:${share.exportPath})`, value: share.id })),
  ]);
  const share = $derived(shares.find((share) => share.id === target));
  const changed = $derived(
    target === LOCAL ? !!item.location : target !== item.location?.shareId || path.trim() !== item.location?.path,
  );

  const onSubmit = async () => {
    saving = true;
    try {
      const saved = await handleUpdateStorageLocation(
        item,
        target === LOCAL ? { shareId: null } : { shareId: target, path: path.trim() },
      );
      if (saved) {
        onClose();
      }
    } finally {
      saving = false;
    }
  };
</script>

<FormModal
  title={$t('storage_location_edit', { values: { name: getStorageLocationTitle($t, item) } })}
  icon={mdiFolderNetworkOutline}
  {onClose}
  {onSubmit}
  size="medium"
  submitText={$t('save')}
  disabled={!changed || saving || (target !== LOCAL && !path.trim())}
>
  <Stack gap={4}>
    <Field label={$t('storage_location_where')}>
      <Select bind:value={target} {options} />
      {#if usable.length === 0}
        <HelperText>{$t('storage_location_no_share')}</HelperText>
      {/if}
    </Field>

    {#if target !== LOCAL}
      <Field label={$t('storage_location_folder')} required>
        <Input bind:value={path} placeholder={item.suggestedPath} />
        <HelperText>
          {$t('storage_location_folder_description', { values: { path: `${share?.mountPath ?? ''}/${path.trim()}` } })}
        </HelperText>
      </Field>
      {#if item.userId}
        <Text size="small">{$t('storage_location_user_description')}</Text>
      {:else}
        <Text size="small">{$t('storage_location_folder_note')}</Text>
      {/if}
    {/if}

    {#if changed}
      <Alert color="info" title={$t('storage_location_move_title')}>
        <Text size="small">{item.userId ? $t('storage_location_move_user') : $t('storage_location_move_folder')}</Text>
      </Alert>
    {/if}
  </Stack>
</FormModal>
