/** The rules a location is inferred by (`metadata.locationInference` in the config), in milliseconds and meters */
export type LocationInferenceRules = {
  /** Between two photos with a location, near enough to each other: how far each may be */
  betweenMs: number;
  /** Otherwise: how near the photo with a location taken nearest must be */
  nearbyMs: number;
  /** How far apart the photos before and after may be, to be "between" them */
  maxDistanceM: number;
};

export const toLocationInferenceRules = (config: {
  betweenMinutes: number;
  nearbyMinutes: number;
  maxDistanceMeters: number;
}): LocationInferenceRules => ({
  betweenMs: config.betweenMinutes * 60_000,
  nearbyMs: config.nearbyMinutes * 60_000,
  maxDistanceM: config.maxDistanceMeters,
});

/** How far from a photo to look for the photos a location may be inferred from, each way */
export const locationInferenceWindowMs = (rules: LocationInferenceRules) => Math.max(rules.betweenMs, rules.nearbyMs);

/** A photo with a location; its time is the local one (asset.localDateTime) */
export type LocationSource = {
  id: string;
  latitude: number | null;
  longitude: number | null;
  localDateTime: Date | string | null;
};

export type InferredLocation = { latitude: number; longitude: number; sourceId: string };

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** The great-circle distance (haversine) */
export const distanceInMeters = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) => {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

const pick = (source: { id: string; latitude: number; longitude: number }): InferredLocation => ({
  latitude: source.latitude,
  longitude: source.longitude,
  sourceId: source.id,
});

/**
 * The location of a photo taken at `time` (local, as are the others) without one, from the photos with one taken just
 * before and just after it. Of the two, the one nearer in time (the one before, if as near):
 * - between: both within `betweenMs`, and within `maxDistanceM` of each other (one stayed there meanwhile);
 * - nearby: otherwise, if within `nearbyMs` (one cannot have gone far meanwhile), even with only one of them, or the
 *   two far apart.
 * Otherwise none: better none than a wrong one.
 */
export const inferLocation = (
  time: Date,
  before: LocationSource | undefined,
  after: LocationSource | undefined,
  rules: LocationInferenceRules,
): InferredLocation | null => {
  const at = time.getTime();
  const located = (source: LocationSource | undefined, direction: 1 | -1) => {
    if (!source || source.latitude === null || source.longitude === null || !source.localDateTime) {
      return;
    }
    const gap = direction * (at - new Date(source.localDateTime).getTime());
    return gap < 0 ? undefined : { id: source.id, latitude: source.latitude, longitude: source.longitude, gap };
  };
  const first = located(before, 1);
  const second = located(after, -1);

  if (
    first &&
    second &&
    first.gap <= rules.betweenMs &&
    second.gap <= rules.betweenMs &&
    distanceInMeters(first, second) <= rules.maxDistanceM
  ) {
    return pick(first.gap <= second.gap ? first : second);
  }

  const nearest = [first, second]
    .filter((source) => source !== undefined)
    .toSorted((a, b) => a.gap - b.gap)
    .at(0);
  if (nearest && nearest.gap <= rules.nearbyMs) {
    return pick(nearest);
  }

  return null;
};
