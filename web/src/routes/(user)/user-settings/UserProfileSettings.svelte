<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyUser } from '@immich/sdk';
  import { Button, Field, Input, PasswordInput, toastManager } from '@immich/ui';
  import { cloneDeep } from 'lodash-es';
  import { t } from 'svelte-i18n';
  import { createBubbler, preventDefault } from 'svelte/legacy';
  import { fade } from 'svelte/transition';

  let editedUser = $state(cloneDeep(authManager.user));
  let currentPassword = $state('');
  const bubble = createBubbler();

  const changesEmail = $derived(editedUser.email.trim().toLowerCase() !== authManager.user.email.toLowerCase());

  const handleSaveProfile = async () => {
    try {
      const data = await updateMyUser({
        userUpdateMeDto: {
          email: editedUser.email,
          name: editedUser.name,
          currentPassword: changesEmail && currentPassword ? currentPassword : undefined,
        },
      });

      Object.assign(editedUser, data);
      authManager.setUser(data);
      currentPassword = '';

      toastManager.primary($t('saved_profile'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_profile'));
    }
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={preventDefault(bubble('submit'))}>
      <div class="flex flex-col gap-4 sm:ms-8">
        <Field label={$t('user_id')} disabled>
          <Input bind:value={editedUser.id} />
        </Field>

        <Field label={$t('email')} required>
          <Input type="email" bind:value={editedUser.email} />
        </Field>

        {#if changesEmail}
          <Field label={$t('current_password')} description={$t('change_email_password_description')}>
            <PasswordInput bind:value={currentPassword} autocomplete="current-password" />
          </Field>
        {/if}

        <Field label={$t('name')} required>
          <Input bind:value={editedUser.name} />
        </Field>

        <Field label={$t('storage_label')} disabled>
          <Input value={editedUser.storageLabel || ''} />
        </Field>

        <div class="flex justify-end">
          <Button shape="round" type="submit" size="small" onclick={() => handleSaveProfile()}>{$t('save')}</Button>
        </div>
      </div>
    </form>
  </div>
</section>
