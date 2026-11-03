import { distanceInMeters, inferLocation } from 'src/utils/location-inference.js';

const at = (time: string) => new Date(`2026-10-01T${time}:00.000Z`);
const source = (time: string, latitude: number, longitude: number) => ({
  latitude,
  longitude,
  localDateTime: at(time),
});

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

describe('inferLocation', () => {
  it('takes the location of the photo nearer in time, between two close together', () => {
    const before = source('10:00', bund.latitude, bund.longitude);
    const after = source('10:30', nearBund.latitude, nearBund.longitude);
    expect(inferLocation(at('10:10'), before, after)).toEqual(bund);
    expect(inferLocation(at('10:20'), before, after)).toEqual(nearBund);
    // as near: the one before
    expect(inferLocation(at('10:15'), before, after)).toEqual(bund);
  });

  it('infers none without a photo on both sides', () => {
    const before = source('10:00', bund.latitude, bund.longitude);
    expect(inferLocation(at('10:10'), before, undefined)).toBeNull();
    expect(inferLocation(at('10:10'), undefined, before)).toBeNull();
  });

  it('infers none when one of them was taken more than an hour away', () => {
    const before = source('09:00', bund.latitude, bund.longitude);
    const after = source('10:30', nearBund.latitude, nearBund.longitude);
    expect(inferLocation(at('10:01'), before, after)).toBeNull();
    expect(inferLocation(at('10:00'), before, after)).toEqual(nearBund);
  });

  it('infers none when they were taken more than a kilometer apart: the photo could be anywhere between', () => {
    const before = source('10:00', bund.latitude, bund.longitude);
    const after = source('10:30', farther.latitude, farther.longitude);
    expect(inferLocation(at('10:01'), before, after)).toBeNull();
  });

  it('infers none from photos without a location or a date, or on the wrong side', () => {
    const before = source('10:00', bund.latitude, bund.longitude);
    const after = source('10:30', nearBund.latitude, nearBund.longitude);
    expect(inferLocation(at('10:10'), { ...before, latitude: null }, after)).toBeNull();
    expect(inferLocation(at('10:10'), before, { ...after, localDateTime: null })).toBeNull();
    expect(inferLocation(at('10:40'), before, after)).toBeNull();
  });

  it('infers from a photo taken at the same time', () => {
    const same = source('10:00', bund.latitude, bund.longitude);
    expect(inferLocation(at('10:00'), same, same)).toEqual(bund);
  });
});
