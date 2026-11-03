<script lang="ts">
  import GeolocationPointPickerModal from '$lib/modals/GeolocationPointPickerModal.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { clearInferredLocation, getAssetInfo, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Icon, IconButton, modalManager } from '@immich/ui';
  import { mdiClose, mdiMapMarkerOutline, mdiPencil } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    isOwner: boolean;
    asset: AssetResponseDto;
  };

  let { isOwner, asset = $bindable() }: Props = $props();

  const isInferred = $derived(asset.exifInfo?.locationInferred === true);

  const onAction = async () => {
    const point = await modalManager.show(GeolocationPointPickerModal, { asset });
    if (!point) {
      return;
    }

    try {
      asset = await updateAsset({
        id: asset.id,
        updateAssetDto: { latitude: point.lat, longitude: point.lng },
      });
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_location'));
    }
  };

  const onClearInferred = async () => {
    const confirmed = await modalManager.showDialog({ prompt: $t('location_inferred_clear_prompt') });
    if (!confirmed) {
      return;
    }

    try {
      await clearInferredLocation({ id: asset.id });
      asset = await getAssetInfo({ id: asset.id });
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_location'));
    }
  };
</script>

{#if asset.exifInfo?.country}
  <div class="flex w-full place-items-start gap-2">
    <button
      type="button"
      class="flex w-full place-items-start justify-between gap-4 py-4 text-start"
      onclick={isOwner ? onAction : undefined}
      title={isOwner ? $t('edit_location') : ''}
      class:hover:text-primary={isOwner}
    >
      <div class="flex gap-4">
        <div><Icon icon={mdiMapMarkerOutline} size="24" /></div>

        <div>
          {#if asset.exifInfo?.city}
            <p>{asset.exifInfo.city}</p>
          {/if}
          {#if asset.exifInfo?.state}
            <div class="flex gap-2 text-sm">
              <p>{asset.exifInfo.state}</p>
            </div>
          {/if}
          {#if asset.exifInfo?.country}
            <div class="flex gap-2 text-sm">
              <p>{asset.exifInfo.country}</p>
            </div>
          {/if}
          {#if isInferred}
            <div class="mt-1" title={$t('location_inferred_description')}>
              <Badge size="tiny" color="secondary">{$t('location_inferred')}</Badge>
            </div>
          {/if}
        </div>
      </div>

      {#if isOwner}
        <div>
          <Icon icon={mdiPencil} size="20" />
        </div>
      {/if}
    </button>

    {#if isOwner && isInferred}
      <div class="py-3">
        <IconButton
          aria-label={$t('location_inferred_clear')}
          title={$t('location_inferred_clear')}
          icon={mdiClose}
          size="small"
          shape="round"
          color="secondary"
          variant="ghost"
          onclick={onClearInferred}
        />
      </div>
    {/if}
  </div>
{:else if !asset.exifInfo?.city && isOwner}
  <button
    type="button"
    class="flex w-full place-items-start justify-between gap-4 rounded-lg py-4 text-start hover:text-primary"
    onclick={onAction}
    title={$t('add_location')}
  >
    <div class="flex gap-4">
      <div><Icon icon={mdiMapMarkerOutline} size="24" /></div>
      <p>{$t('add_a_location')}</p>
    </div>
    <div class="p-1 focus:outline-none">
      <Icon icon={mdiPencil} size="20" />
    </div>
  </button>
{/if}
