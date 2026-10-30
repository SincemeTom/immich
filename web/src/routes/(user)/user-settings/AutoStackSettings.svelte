<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { removeAutoStacks, runAutoStack, updateMyPreferences } from '@immich/sdk';
  import {
    Alert,
    Button,
    Field,
    NumberInput,
    Select,
    Stack,
    Switch,
    Text,
    modalManager,
    toastManager,
  } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const saved = authManager.preferences.autoStack;

  let enabled = $state(saved?.enabled ?? false);
  let burst = $state(saved?.burst ?? true);
  let rawJpeg = $state(saved?.rawJpeg ?? true);
  let edited = $state(saved?.edited ?? true);
  let similar = $state(saved?.similar ?? false);
  let maxDistance = $state(String(saved?.maxDistance ?? 0.02));
  let maxSeconds = $state<number | undefined>(saved?.maxSeconds ?? 10);
  let busy = $state(false);

  const presets = ['0.01', '0.02', '0.03'];
  const similarityOptions = $derived([
    { label: $t('auto_stack_similarity_strict'), value: '0.01' },
    { label: $t('auto_stack_similarity_default'), value: '0.02' },
    { label: $t('auto_stack_similarity_loose'), value: '0.03' },
    ...(presets.includes(maxDistance) ? [] : [{ label: maxDistance, value: maxDistance }]),
  ]);

  const save = async () => {
    const response = await updateMyPreferences({
      userPreferencesUpdateDto: {
        autoStack: {
          enabled,
          burst,
          rawJpeg,
          edited,
          similar,
          maxDistance: Number(maxDistance),
          maxSeconds: Math.min(Math.max(Math.round(maxSeconds ?? 10), 1), 600),
        },
      },
    });
    authManager.setPreferences(response);
  };

  const handleSave = async () => {
    busy = true;
    try {
      await save();
      if (enabled) {
        await runAutoStack({ autoStackRunDto: {} });
        toastManager.primary($t('auto_stack_saved_running'));
      } else {
        toastManager.primary($t('saved_settings'));
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    } finally {
      busy = false;
    }
  };

  const handleRedo = async () => {
    const confirmed = await modalManager.showDialog({ prompt: $t('auto_stack_redo_prompt') });
    if (!confirmed) {
      return;
    }

    busy = true;
    try {
      await save();
      const { count } = await removeAutoStacks();
      await runAutoStack({ autoStackRunDto: {} });
      toastManager.primary($t('auto_stack_redo_done', { values: { count } }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_auto_stack'));
    } finally {
      busy = false;
    }
  };

  const handleRemove = async () => {
    const confirmed = await modalManager.showDialog({ prompt: $t('auto_stack_remove_prompt') });
    if (!confirmed) {
      return;
    }

    busy = true;
    try {
      const { count } = await removeAutoStacks();
      toastManager.primary($t('auto_stack_removed', { values: { count } }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_auto_stack'));
    } finally {
      busy = false;
    }
  };

  const onsubmit = (event: Event) => {
    event.preventDefault();
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" {onsubmit}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <Text size="small">{$t('auto_stack_description')}</Text>

        <Field label={$t('enable')}>
          <Switch bind:checked={enabled} />
        </Field>

        {#if enabled}
          <Field label={$t('auto_stack_burst')} description={$t('auto_stack_burst_description')}>
            <Switch bind:checked={burst} />
          </Field>
          <Field label={$t('auto_stack_raw_jpeg')} description={$t('auto_stack_raw_jpeg_description')}>
            <Switch bind:checked={rawJpeg} />
          </Field>
          <Field label={$t('auto_stack_edited')} description={$t('auto_stack_edited_description')}>
            <Switch bind:checked={edited} />
          </Field>
          <Field label={$t('auto_stack_similar')} description={$t('auto_stack_similar_description')}>
            <Switch bind:checked={similar} />
          </Field>

          {#if similar}
            <Stack gap={4} class="sm:ms-4">
              <Field label={$t('auto_stack_similarity')} description={$t('auto_stack_similarity_description')}>
                <Select bind:value={maxDistance} options={similarityOptions} />
              </Field>
              <Field label={$t('auto_stack_seconds')} description={$t('auto_stack_seconds_description')}>
                <NumberInput bind:value={maxSeconds} min={1} max={600} />
              </Field>
            </Stack>
          {/if}

          <Alert color="info" size="small">
            <Text size="small">{$t('auto_stack_note')}</Text>
          </Alert>
        {/if}

        <div class="flex flex-wrap justify-end gap-2">
          <Button shape="round" size="small" variant="outline" color="danger" disabled={busy} onclick={handleRemove}>
            {$t('auto_stack_remove')}
          </Button>
          {#if enabled}
            <Button shape="round" size="small" variant="outline" disabled={busy} onclick={handleRedo}>
              {$t('auto_stack_redo')}
            </Button>
          {/if}
          <Button shape="round" type="submit" size="small" loading={busy} disabled={busy} onclick={handleSave}>
            {$t('save')}
          </Button>
        </div>
      </div>
    </form>
  </div>
</section>
