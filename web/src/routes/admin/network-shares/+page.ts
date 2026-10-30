import { getNetworkShares } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, depends }) => {
  depends('app:network-shares');
  await authenticate(url, { admin: true });
  if (!featureFlagsManager.value.networkShares) {
    redirect(307, Route.libraries());
  }

  const shares = await getNetworkShares();
  const $t = await getFormatter();

  return {
    shares,
    meta: {
      title: $t('network_shares'),
    },
  };
}) satisfies PageLoad;
