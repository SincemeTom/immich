import { getNetworkShares, getStorageLocations } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  depends('app:storage-locations');
  await authenticate(url, { admin: true });
  if (!featureFlagsManager.value.networkShares) {
    redirect(307, Route.systemSettings());
  }

  const [locations, shares] = await Promise.all([getStorageLocations(), getNetworkShares()]);
  const $t = await getFormatter();

  return {
    locations,
    shares,
    meta: {
      title: $t('storage_locations'),
    },
  };
}) satisfies PageLoad;
