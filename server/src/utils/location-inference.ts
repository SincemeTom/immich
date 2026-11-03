/** How far apart in time the photos a location is inferred from may be from the photo, each way */
export const LOCATION_INFERENCE_WINDOW_MS = 60 * 60 * 1000;
/** How far apart the photos taken before and after it may be: farther, and the photo could be anywhere between */
export const LOCATION_INFERENCE_MAX_DISTANCE_M = 1000;

/** A photo with a location; its time is the local one (asset.localDateTime) */
export type LocationSource = { latitude: number | null; longitude: number | null; localDateTime: Date | null };

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

/**
 * The location of a photo taken at `time` (local, as are the others) without one: where the photos taken just before and just after it were, if
 * both were taken within the window and within LOCATION_INFERENCE_MAX_DISTANCE_M of each other, the location of the
 * one nearer in time (the one before, if as near). Otherwise none: better none than a wrong one.
 */
export const inferLocation = (
  time: Date,
  before: LocationSource | undefined,
  after: LocationSource | undefined,
): { latitude: number; longitude: number } | null => {
  const located = (source?: LocationSource) =>
    source && source.latitude !== null && source.longitude !== null && source.localDateTime
      ? { latitude: source.latitude, longitude: source.longitude, at: new Date(source.localDateTime).getTime() }
      : undefined;
  const first = located(before);
  const second = located(after);
  if (!first || !second) {
    return null;
  }

  const at = time.getTime();
  const sinceFirst = at - first.at;
  const untilSecond = second.at - at;
  if (sinceFirst < 0 || untilSecond < 0) {
    return null;
  }
  if (sinceFirst > LOCATION_INFERENCE_WINDOW_MS || untilSecond > LOCATION_INFERENCE_WINDOW_MS) {
    return null;
  }
  if (distanceInMeters(first, second) > LOCATION_INFERENCE_MAX_DISTANCE_M) {
    return null;
  }

  const nearer = sinceFirst <= untilSecond ? first : second;
  return { latitude: nearer.latitude, longitude: nearer.longitude };
};
