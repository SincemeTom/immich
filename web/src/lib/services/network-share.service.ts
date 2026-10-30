import {
  createNetworkShare,
  deleteNetworkShare,
  mountNetworkShare,
  NetworkShareErrorReason,
  NetworkShareStatus,
  testNetworkShare,
  unmountNetworkShare,
  updateNetworkShare,
  type NetworkShareCreateDto,
  type NetworkShareResponseDto,
  type NetworkShareTestDto,
  type NetworkShareUpdateDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import { mdiLanConnect, mdiLanDisconnect, mdiPencilOutline, mdiPlusBoxOutline, mdiTrashCanOutline } from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { eventManager } from '$lib/managers/event-manager.svelte';
import NetworkShareModal from '$lib/modals/NetworkShareModal.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const getNetworkSharesActions = ($t: MessageFormatter) => {
  const Create: ActionItem = {
    title: $t('network_share_add'),
    icon: mdiPlusBoxOutline,
    onAction: () => modalManager.show(NetworkShareModal, {}),
    shortcuts: { shift: true, key: 'n' },
  };

  return { Create };
};

export const getNetworkShareActions = ($t: MessageFormatter, share: NetworkShareResponseDto) => {
  const Edit: ActionItem = {
    icon: mdiPencilOutline,
    title: $t('edit'),
    onAction: () => modalManager.show(NetworkShareModal, { share }),
  };

  const Mount: ActionItem = {
    icon: mdiLanConnect,
    title: $t('network_share_mount'),
    onAction: () => handleMountNetworkShare(share),
  };

  const Unmount: ActionItem = {
    icon: mdiLanDisconnect,
    title: $t('network_share_unmount'),
    onAction: () => handleUnmountNetworkShare(share),
  };

  const Delete: ActionItem = {
    icon: mdiTrashCanOutline,
    title: $t('delete'),
    color: 'danger',
    onAction: () => handleDeleteNetworkShare(share),
  };

  return { Edit, Mount, Unmount, Delete };
};

/** What to do about a share that would not mount, for the reason the server gives */
export const getNetworkShareErrorHint = ($t: MessageFormatter, reason?: NetworkShareErrorReason) => {
  switch (reason) {
    case NetworkShareErrorReason.Unreachable: {
      return $t('network_share_error_unreachable');
    }
    case NetworkShareErrorReason.Denied: {
      return $t('network_share_error_denied');
    }
    case NetworkShareErrorReason.NotFound: {
      return $t('network_share_error_not_found');
    }
    case NetworkShareErrorReason.MacPermission: {
      return $t('network_share_error_mac_permission');
    }
    default: {
      return $t('network_share_error_other');
    }
  }
};

export const handleTestNetworkShare = async (dto: NetworkShareTestDto) => {
  const $t = await getFormatter();

  try {
    return await testNetworkShare({ networkShareTestDto: dto });
  } catch (error) {
    handleError(error, $t('errors.unable_to_test_network_share'));
  }
};

export const handleCreateNetworkShare = async (dto: NetworkShareCreateDto) => {
  const $t = await getFormatter();

  try {
    const share = await createNetworkShare({ networkShareCreateDto: dto });
    eventManager.emit('NetworkShareCreate', share);
    toastManager.primary($t('network_share_added', { values: { name: share.name } }));
    return share;
  } catch (error) {
    handleError(error, $t('errors.unable_to_add_network_share'));
  }
};

export const handleUpdateNetworkShare = async (share: NetworkShareResponseDto, dto: NetworkShareUpdateDto) => {
  const $t = await getFormatter();

  try {
    const updated = await updateNetworkShare({ id: share.id, networkShareUpdateDto: dto });
    eventManager.emit('NetworkShareUpdate', updated);
    toastManager.primary($t('network_share_updated'));
    return updated;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_network_share'));
  }
};

const handleMountNetworkShare = async (share: NetworkShareResponseDto) => {
  const $t = await getFormatter();

  try {
    const updated = await mountNetworkShare({ id: share.id });
    eventManager.emit('NetworkShareUpdate', updated);
    if (updated.status === NetworkShareStatus.Mounted) {
      toastManager.primary($t('network_share_mounted', { values: { name: share.name } }));
    } else {
      toastManager.danger(getNetworkShareErrorHint($t, updated.errorReason));
    }
  } catch (error) {
    handleError(error, $t('errors.unable_to_mount_network_share'));
  }
};

const handleUnmountNetworkShare = async (share: NetworkShareResponseDto) => {
  const $t = await getFormatter();

  if (share.libraries.length > 0) {
    const confirmed = await modalManager.showDialog({
      prompt: $t('network_share_unmount_prompt', { values: { libraries: share.libraries.join(', ') } }),
    });
    if (!confirmed) {
      return;
    }
  }

  try {
    const updated = await unmountNetworkShare({ id: share.id });
    eventManager.emit('NetworkShareUpdate', updated);
    toastManager.primary($t('network_share_unmounted', { values: { name: share.name } }));
  } catch (error) {
    handleError(error, $t('errors.unable_to_unmount_network_share'));
  }
};

const handleDeleteNetworkShare = async (share: NetworkShareResponseDto) => {
  const $t = await getFormatter();

  if (share.libraries.length > 0) {
    toastManager.danger($t('network_share_in_use', { values: { libraries: share.libraries.join(', ') } }));
    return;
  }

  const confirmed = await modalManager.showDialog({
    prompt: $t('network_share_delete_prompt', { values: { name: share.name } }),
  });
  if (!confirmed) {
    return;
  }

  try {
    await deleteNetworkShare({ id: share.id });
    eventManager.emit('NetworkShareDelete', { id: share.id });
    toastManager.primary($t('network_share_deleted', { values: { name: share.name } }));
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_network_share'));
  }
};
