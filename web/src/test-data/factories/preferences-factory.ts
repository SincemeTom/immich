import { AssetOrder, PersonUpdateStrategy, type UserPreferencesResponseDto } from '@immich/sdk';
import { Sync } from 'factory.ts';

export const preferencesFactory = Sync.makeFactory<UserPreferencesResponseDto>({
  albums: {
    defaultAssetOrder: AssetOrder.Desc,
  },
  autoStack: {
    enabled: false,
    burst: true,
    rawJpeg: true,
    edited: true,
    similar: false,
    maxDistance: 0.06,
    maxSeconds: 10,
  },
  cast: {
    gCastEnabled: false,
  },
  download: {
    archiveSize: 0,
    includeEmbeddedVideos: false,
  },
  emailNotifications: {
    albumInvite: false,
    albumUpdate: false,
    enabled: false,
  },
  folders: {
    enabled: false,
    sidebarWeb: false,
  },
  memories: {
    enabled: false,
    duration: 5,
    sidebarWeb: false,
  },
  people: {
    enabled: false,
    sidebarWeb: false,
    updateStrategy: PersonUpdateStrategy.Everyone,
  },
  purchase: {
    hideBuyButtonUntil: '',
    showSupportBadge: false,
  },
  ratings: {
    enabled: false,
  },
  sharedLinks: {
    enabled: false,
    sidebarWeb: false,
  },
  tags: {
    enabled: false,
    sidebarWeb: false,
  },
  recentlyAdded: {
    sidebarWeb: false,
  },
});
