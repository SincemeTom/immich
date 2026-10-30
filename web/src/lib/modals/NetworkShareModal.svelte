<script lang="ts">
  import {
    getNetworkShareErrorHint,
    handleCreateNetworkShare,
    handleTestNetworkShare,
    handleUpdateNetworkShare,
  } from '$lib/services/network-share.service';
  import { NfsVersion, type NetworkShareResponseDto, type NetworkShareTestResponseDto } from '@immich/sdk';
  import { Alert, Button, Field, FormModal, HelperText, Input, Select, Stack, Switch, Text } from '@immich/ui';
  import { mdiLanCheck, mdiNas } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    share?: NetworkShareResponseDto;
    onClose: () => void;
  };

  const { share, onClose }: Props = $props();

  let name = $state(share?.name ?? '');
  let host = $state(share?.host ?? '');
  let exportPath = $state(share?.exportPath ?? '');
  let nfsVersion = $state<NfsVersion>(share?.nfsVersion ?? NfsVersion.Auto);
  let readOnly = $state(share?.readOnly ?? false);
  let testing = $state(false);
  let saving = $state(false);
  let result = $state<NetworkShareTestResponseDto>();
  // the name follows the address until it is typed in
  let nameEdited = $state(!!share);

  const connection = $derived({ host: host.trim(), exportPath: exportPath.trim(), nfsVersion, readOnly });
  const isComplete = $derived(!!connection.host && connection.exportPath.startsWith('/') && !!name.trim());

  const nfsVersions = $derived([
    { label: $t('network_share_nfs_version_auto'), value: NfsVersion.Auto },
    { label: 'NFSv3', value: NfsVersion.$3 },
    { label: 'NFSv4', value: NfsVersion.$4 },
  ]);

  const onAddressInput = () => {
    result = undefined;
    if (!nameEdited) {
      const folder = exportPath.trim().split('/').findLast(Boolean);
      name = folder ?? '';
    }
  };

  const onTest = async () => {
    testing = true;
    try {
      result = await handleTestNetworkShare(connection);
    } finally {
      testing = false;
    }
  };

  const onSubmit = async () => {
    saving = true;
    try {
      const saved = share
        ? await handleUpdateNetworkShare(share, { ...connection, name: name.trim() })
        : await handleCreateNetworkShare({ ...connection, name: name.trim() });
      if (saved) {
        onClose();
      }
    } finally {
      saving = false;
    }
  };
</script>

<FormModal
  title={share ? $t('network_share_edit') : $t('network_share_add')}
  icon={mdiNas}
  {onClose}
  {onSubmit}
  size="medium"
  submitText={share ? $t('save') : $t('add')}
  disabled={!isComplete || saving || testing}
>
  <Stack gap={4}>
    <Text size="small">{$t('network_share_description')}</Text>

    <Field label={$t('network_share_host')} required>
      <Input bind:value={host} placeholder="192.168.1.10" oninput={onAddressInput} />
      <HelperText>{$t('network_share_host_description')}</HelperText>
    </Field>

    <Field label={$t('network_share_export_path')} required>
      <Input bind:value={exportPath} placeholder="/volume1/photo" oninput={onAddressInput} />
      <HelperText>{$t('network_share_export_path_description')}</HelperText>
    </Field>

    <Field label={$t('name')} required>
      <Input bind:value={name} oninput={() => (nameEdited = true)} />
      <HelperText>{$t('network_share_name_description')}</HelperText>
    </Field>

    <Field label={$t('network_share_nfs_version')}>
      <Select bind:value={nfsVersion} options={nfsVersions} onChange={() => (result = undefined)} />
    </Field>

    <Field label={$t('network_share_read_only')} description={$t('network_share_read_only_description')}>
      <Switch bind:checked={readOnly} onCheckedChange={() => (result = undefined)} />
    </Field>

    <div>
      <Button
        size="small"
        variant="outline"
        leadingIcon={mdiLanCheck}
        loading={testing}
        disabled={!connection.host || !connection.exportPath.startsWith('/') || testing}
        onclick={onTest}
      >
        {$t('network_share_test')}
      </Button>
    </div>

    {#if result?.success}
      <Alert color="success" title={$t('network_share_test_success')}>
        {#if result.entries.length > 0}
          <Text size="small" class="break-all">{result.entries.join(' · ')}</Text>
        {:else}
          <Text size="small">{$t('network_share_test_empty')}</Text>
        {/if}
      </Alert>
    {:else if result}
      <Alert color="danger" title={$t('network_share_test_failed')}>
        <Stack gap={1}>
          <Text size="small">{getNetworkShareErrorHint($t, result.errorReason)}</Text>
          {#if result.message}
            <Text size="tiny" class="font-mono break-all opacity-75">{result.message}</Text>
          {/if}
        </Stack>
      </Alert>
    {/if}
  </Stack>
</FormModal>
