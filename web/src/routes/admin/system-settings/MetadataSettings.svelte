<script lang="ts">
  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { clearInferredLocations } from '@immich/sdk';
  import { Button, modalManager, Text, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());
  let clearing = $state(false);

  const handleClearInferred = async () => {
    const confirmed = await modalManager.showDialog({ prompt: $t('admin.location_inference_clear_prompt') });
    if (!confirmed) {
      return;
    }

    clearing = true;
    try {
      const { count } = await clearInferredLocations();
      toastManager.primary($t('admin.location_inference_cleared', { values: { count } }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_location'));
    } finally {
      clearing = false;
    }
  };
</script>

<div class="mt-2">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" class="mx-4 mt-4" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <SettingSwitch
          title={$t('admin.metadata_faces_import_setting')}
          subtitle={$t('admin.metadata_faces_import_setting_description')}
          bind:checked={configToEdit.metadata.faces.import}
          {disabled}
        />

        <SettingSwitch
          title={$t('admin.location_inference_setting')}
          subtitle={$t('admin.location_inference_setting_description')}
          bind:checked={configToEdit.metadata.locationInference.enabled}
          {disabled}
        />

        {#if configToEdit.metadata.locationInference.enabled}
          <div class="ms-4 flex flex-col gap-4">
            <SettingInputField
              inputType={SettingInputFieldType.NUMBER}
              label={$t('admin.location_inference_nearby_minutes')}
              description={$t('admin.location_inference_nearby_minutes_description')}
              bind:value={configToEdit.metadata.locationInference.nearbyMinutes}
              min={0}
              max={1440}
              required={true}
              {disabled}
              isEdited={configToEdit.metadata.locationInference.nearbyMinutes !==
                config.metadata.locationInference.nearbyMinutes}
            />
            <SettingInputField
              inputType={SettingInputFieldType.NUMBER}
              label={$t('admin.location_inference_between_minutes')}
              description={$t('admin.location_inference_between_minutes_description')}
              bind:value={configToEdit.metadata.locationInference.betweenMinutes}
              min={0}
              max={1440}
              required={true}
              {disabled}
              isEdited={configToEdit.metadata.locationInference.betweenMinutes !==
                config.metadata.locationInference.betweenMinutes}
            />
            <SettingInputField
              inputType={SettingInputFieldType.NUMBER}
              label={$t('admin.location_inference_max_distance')}
              description={$t('admin.location_inference_max_distance_description')}
              bind:value={configToEdit.metadata.locationInference.maxDistanceMeters}
              min={0}
              max={100_000}
              required={true}
              {disabled}
              isEdited={configToEdit.metadata.locationInference.maxDistanceMeters !==
                config.metadata.locationInference.maxDistanceMeters}
            />
          </div>
        {/if}

        <div class="flex flex-col gap-2">
          <Text size="small" color="muted">{$t('admin.location_inference_clear_description')}</Text>
          <div>
            <Button
              shape="round"
              size="small"
              variant="outline"
              color="danger"
              loading={clearing}
              disabled={clearing}
              onclick={handleClearInferred}
            >
              {$t('admin.location_inference_clear')}
            </Button>
          </div>
        </div>
      </div>

      <SettingButtonsRow bind:configToEdit keys={['metadata']} {disabled} />
    </form>
  </div>
</div>
