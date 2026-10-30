import {
  updateStorageLocationFolder,
  updateStorageLocationUser,
  type StorageLocationFolder,
  type StorageLocationItemDto,
  type StorageLocationUpdateDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import type { MessageFormatter } from 'svelte-i18n';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/** What a row holds: thumbnails, encoded videos, backups, or a user's originals */
export const getStorageLocationTitle = ($t: MessageFormatter, item: StorageLocationItemDto) => {
  switch (item.folder) {
    case 'thumbs' as StorageLocationFolder: {
      return $t('storage_location_thumbs');
    }
    case 'encoded-video' as StorageLocationFolder: {
      return $t('storage_location_encoded_video');
    }
    case 'backups' as StorageLocationFolder: {
      return $t('storage_location_backups');
    }
    default: {
      return item.userName || item.userEmail || '';
    }
  }
};

export const handleUpdateStorageLocation = async (item: StorageLocationItemDto, dto: StorageLocationUpdateDto) => {
  const $t = await getFormatter();
  try {
    if (item.folder) {
      await updateStorageLocationFolder({ folder: item.folder, storageLocationUpdateDto: dto });
    } else if (item.userId) {
      await updateStorageLocationUser({ id: item.userId, storageLocationUpdateDto: dto });
    }
    toastManager.primary($t('storage_location_saved'));
    eventManager.emit('StorageLocationUpdate');
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_storage_location'));
    return false;
  }
};
