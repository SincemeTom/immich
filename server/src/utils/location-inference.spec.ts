import {
  distanceInMeters,
  inferLocation,
  locationInferenceWindowMs,
  toLocationInferenceRules,
} from 'src/utils/location-inference.js';

const at = (time: string) => new Date(`2026-10-01T${time}:00.000Z`);
const source = (id: string, time: string, latitude: number, longitude: number) => ({
  id,
  latitude,
  longitude,
  localDateTime: at(time),
});

// the defaults: between two within 3 hours each and 1 km apart; otherwise, the nearest within 30 minutes
const rules = toLocationInferenceRules({ betweenMinutes: 180, nearbyMinutes: 30, maxDistanceMeters: 1000 });

// two places in Shanghai about 400 m apart, and one about 2 km away
const bund = { latitude: 31.24, longitude: 121.49 };
const nearBund = { latitude: 31.2436, longitude: 121.49 };
const farther = { latitude: 31.258, longitude: 121.49 };

describe('distanceInMeters', () => {
  it('measures along the earth', () => {
    expect(distanceInMeters(bund, nearBund)).toBeCloseTo(400, -1);
    expect(distanceInMeters(bund, farther)).toBeCloseTo(2001, -1);
    expect(distanceInMeters(bund, bund)).toBe(0);
  });
});

describe('toLocationInferenceRules', () => {
  it('turns minutes into milliseconds, and looks as far as the longer of the two', () => {
    expect(rules).toEqual({ betweenMs: 10_800_000, nearbyMs: 1_800_000, maxDistanceM: 1000 });
    expect(locationInferenceWindowMs(rules)).toBe(10_800_000);
    expect(locationInferenceWindowMs({ ...rules, nearbyMs: 20_000_000 })).toBe(20_000_000);
  });
});

describe('inferLocation', () => {
  it('takes the location of the photo nearer in time, between two close together', () => {
    const before = source('b', '10:00', bund.latitude, bund.longitude);
    const after = source('a', '10:30', nearBund.latitude, nearBund.longitude);
    expect(inferLocation(at('10:10'), before, after, rules)).toEqual({ ...bund, sourceId: 'b' });
    expect(inferLocation(at('10:20'), before, after, rules)).toEqual({ ...nearBund, sourceId: 'a' });
    // as near: the one before
    expect(inferLocation(at('10:15'), before, after, rules)).toEqual({ ...bund, sourceId: 'b' });
  });

  it('infers between two close together up to 3 hours away each', () => {
    const before = source('b', '07:00', bund.latitude, bund.longitude);
    const after = source('a', '15:00', nearBund.latitude, nearBund.longitude);
    expect(inferLocation(at('10:00'), before, after, rules)).toBeNull();
    const closer = source('b', '08:00', bund.latitude, bund.longitude);
    const nearer = source('a', '13:00', nearBund.latitude, nearBund.longitude);
    expect(inferLocation(at('10:00'), closer, nearer, rules)).toEqual({ ...bund, sourceId: 'b' });
    expect(inferLocation(at('10:40'), closer, nearer, rules)).toEqual({ ...nearBund, sourceId: 'a' });
    // 3 hours each at most
    expect(inferLocation(at('10:00'), before, nearer, rules)).toEqual({ ...bund, sourceId: 'b' });
    expect(inferLocation(at('10:01'), before, nearer, rules)).toBeNull();
  });

  it('infers from a photo on one side only, taken within 30 minutes', () => {
    const before = source('b', '10:00', bund.latitude, bund.longitude);
    expect(inferLocation(at('10:30'), before, undefined, rules)).toEqual({ ...bund, sourceId: 'b' });
    expect(inferLocation(at('10:31'), before, undefined, rules)).toBeNull();
    expect(inferLocation(at('09:30'), undefined, before, rules)).toEqual({ ...bund, sourceId: 'b' });
    expect(inferLocation(at('09:29'), undefined, before, rules)).toBeNull();
  });

  it('between two far apart, infers from the nearest only within 30 minutes', () => {
    const before = source('b', '10:00', bund.latitude, bund.longitude);
    const after = source('a', '11:30', farther.latitude, farther.longitude);
    expect(inferLocation(at('10:20'), before, after, rules)).toEqual({ ...bund, sourceId: 'b' });
    expect(inferLocation(at('11:10'), before, after, rules)).toEqual({ ...farther, sourceId: 'a' });
    expect(inferLocation(at('10:45'), before, after, rules)).toBeNull();
  });

  it('with one side beyond 3 hours, falls back to the nearest within 30 minutes', () => {
    const before = source('b', '06:00', bund.latitude, bund.longitude);
    const after = source('a', '10:20', nearBund.latitude, nearBund.longitude);
    expect(inferLocation(at('10:00'), before, after, rules)).toEqual({ ...nearBund, sourceId: 'a' });
    expect(inferLocation(at('09:40'), before, after, rules)).toBeNull();
  });

  it('follows the rules it is given', () => {
    const before = source('b', '10:00', bund.latitude, bund.longitude);
    const after = source('a', '10:30', farther.latitude, farther.longitude);
    const looser = { betweenMs: 3_600_000, nearbyMs: 0, maxDistanceM: 5000 };
    expect(inferLocation(at('10:20'), before, after, looser)).toEqual({ ...farther, sourceId: 'a' });
    const off = { betweenMs: 0, nearbyMs: 0, maxDistanceM: 0 };
    expect(inferLocation(at('10:20'), before, after, off)).toBeNull();
  });

  it('infers none from photos without a location or a date, or on the wrong side', () => {
    const before = source('b', '10:00', bund.latitude, bund.longitude);
    const after = source('a', '10:30', nearBund.latitude, nearBund.longitude);
    expect(
      inferLocation(at('10:10'), { ...before, latitude: null }, { ...after, localDateTime: null }, rules),
    ).toBeNull();
    expect(inferLocation(at('11:10'), after, before, rules)).toBeNull();
  });

  it('infers from a photo taken at the same time', () => {
    const same = source('s', '10:00', bund.latitude, bund.longitude);
    expect(inferLocation(at('10:00'), same, same, rules)).toEqual({ ...bund, sourceId: 's' });
  });

  it('reads times given as strings', () => {
    const before = {
      ...source('b', '10:00', bund.latitude, bund.longitude),
      localDateTime: '2026-10-01T10:00:00.000Z',
    };
    expect(inferLocation(at('10:05'), before, undefined, rules)).toEqual({ ...bund, sourceId: 'b' });
  });
});
