import type { AutoStackPreferences } from 'src/types.js';
import { AssetType } from 'src/enum.js';
import {
  AutoStackCandidate,
  AutoStackReason,
  compareForPrimary,
  getAutoStackNameKeys,
  getAutoStackReasons,
  getEditedOriginal,
  shouldReplacePrimary,
} from 'src/utils/auto-stack.js';

const preferences: AutoStackPreferences = {
  enabled: true,
  burst: true,
  rawJpeg: true,
  edited: true,
  similar: true,
  maxDistance: 0.06,
  maxSeconds: 10,
};

const taken = new Date('2026-10-28T14:00:31.297Z');

const asset = (originalFileName: string, overrides: Partial<AutoStackCandidate> = {}): AutoStackCandidate => ({
  id: originalFileName,
  type: AssetType.Image,
  originalFileName,
  originalPath: `/nas/photo/2026/10/${originalFileName}`,
  fileCreatedAt: taken,
  isFavorite: false,
  width: 4000,
  height: 3000,
  dateTimeOriginal: taken,
  model: 'ILCE-7CM2',
  rating: null,
  autoStackId: null,
  stackId: null,
  distance: null,
  ...overrides,
});

const order = (...assets: AutoStackCandidate[]) => assets.toSorted(compareForPrimary).map(({ id }) => id);

describe('auto stacking', () => {
  describe(getEditedOriginal.name, () => {
    it.each([
      ['IMG_E1234', 'IMG_1234'],
      ['IMG_E12345', 'IMG_12345'],
      ['IMG_1234-edited', 'IMG_1234'],
      ['IMG_1234 (edited)', 'IMG_1234'],
      ['PXL_20261028_140031-edited', 'PXL_20261028_140031'],
      ['IMG_1234', undefined],
      ['IMG_EDIT', undefined],
      ['CAM00074', undefined],
    ])('%s is an edited copy of %s', (stem, original) => {
      expect(getEditedOriginal(stem)).toBe(original);
    });
  });

  describe(getAutoStackNameKeys.name, () => {
    it('should look for the edited copies of an original', () => {
      expect(getAutoStackNameKeys('IMG_1234.HEIC')).toEqual([
        'img_1234',
        'img_e1234',
        'img_1234-edited',
        'img_1234 (edited)',
      ]);
    });

    it('should look for the original of an edited copy', () => {
      expect(getAutoStackNameKeys('IMG_E1234.HEIC')).toEqual(['img_e1234', 'img_1234']);
    });

    it('should keep a name with dots but the extension', () => {
      expect(getAutoStackNameKeys('2026.10.28 party.ARW')).toContain('2026.10.28 party');
    });
  });

  describe(getAutoStackReasons.name, () => {
    it('should stack a raw file with its JPEG in the same folder', () => {
      expect(getAutoStackReasons(asset('CAM00074.ARW'), asset('CAM00074.JPG'), preferences)).toEqual([
        AutoStackReason.RawJpeg,
      ]);
    });

    it('should stack a ProRAW DNG with its HEIC, whatever the case of the names', () => {
      expect(getAutoStackReasons(asset('IMG_1234.dng'), asset('img_1234.HEIC'), preferences)).toContain(
        AutoStackReason.RawJpeg,
      );
    });

    it('should stack uploads in folders of their own taken at the same moment by the same camera', () => {
      const raw = asset('CAM00074.ARW', { originalPath: '/upload/a/b/1.arw' });
      const jpeg = asset('CAM00074.JPG', { originalPath: '/upload/c/d/2.jpg' });
      expect(getAutoStackReasons(raw, jpeg, preferences)).toEqual([AutoStackReason.RawJpeg]);
    });

    it('should not stack files of the same name from another shoot', () => {
      const raw = asset('DSC00001.ARW', { originalPath: '/nas/2025/DSC00001.ARW' });
      const jpeg = asset('DSC00001.JPG', {
        originalPath: '/nas/2026/DSC00001.JPG',
        dateTimeOriginal: new Date('2025-01-01T00:00:00Z'),
      });
      expect(getAutoStackReasons(raw, jpeg, preferences)).toEqual([]);
    });

    it('should not stack two JPEGs or two raw files of the same name', () => {
      expect(getAutoStackReasons(asset('A.JPG'), asset('A.HEIC'), preferences)).toEqual([]);
      expect(getAutoStackReasons(asset('A.ARW'), asset('A.DNG'), preferences)).toEqual([]);
    });

    it('should stack an iPhone edited copy with its original, either way round', () => {
      expect(getAutoStackReasons(asset('IMG_E1234.HEIC'), asset('IMG_1234.HEIC'), preferences)).toEqual([
        AutoStackReason.Edited,
      ]);
      expect(getAutoStackReasons(asset('IMG_1234.HEIC'), asset('IMG_E1234.JPG'), preferences)).toEqual([
        AutoStackReason.Edited,
      ]);
    });

    it('should stack edited videos with their original, but not a video with a photo', () => {
      const video = { type: AssetType.Video };
      expect(getAutoStackReasons(asset('IMG_E1234.MOV', video), asset('IMG_1234.MOV', video), preferences)).toEqual([
        AutoStackReason.Edited,
      ]);
      expect(getAutoStackReasons(asset('IMG_E1234.MOV', video), asset('IMG_1234.HEIC'), preferences)).toEqual([]);
    });

    it('should stack the photos of a burst', () => {
      expect(
        getAutoStackReasons(
          asset('IMG_1001.HEIC', { autoStackId: 'burst-1' }),
          asset('IMG_1002.HEIC', { autoStackId: 'burst-1' }),
          preferences,
        ),
      ).toEqual([AutoStackReason.Burst]);
      expect(
        getAutoStackReasons(
          asset('IMG_1001.HEIC', { autoStackId: 'burst-1' }),
          asset('IMG_1002.HEIC', { autoStackId: 'burst-2' }),
          preferences,
        ),
      ).toEqual([]);
    });

    it('should stack similar photos taken within the window', () => {
      const later = new Date(taken.getTime() + 4000);
      expect(
        getAutoStackReasons(
          asset('IMG_5571.HEIC'),
          asset('IMG_5573.HEIC', { fileCreatedAt: later, distance: 0.0141 }),
          preferences,
        ),
      ).toEqual([AutoStackReason.Similar]);
    });

    it.each([
      { name: 'too different', distance: 0.08, seconds: 4 },
      { name: 'too far apart', distance: 0.0096, seconds: 38 },
      { name: 'without an embedding', distance: null, seconds: 1 },
    ])('should not stack similar photos $name', ({ distance, seconds }) => {
      const later = new Date(taken.getTime() + seconds * 1000);
      expect(
        getAutoStackReasons(asset('A.HEIC'), asset('B.HEIC', { fileCreatedAt: later, distance }), preferences),
      ).toEqual([]);
    });

    it('should follow each preference', () => {
      const off = { ...preferences, burst: false, rawJpeg: false, edited: false, similar: false };
      const candidate = asset('IMG_1234.HEIC', { autoStackId: 'b', distance: 0 });
      expect(getAutoStackReasons(asset('IMG_E1234.HEIC', { autoStackId: 'b' }), candidate, off)).toEqual([]);
      expect(getAutoStackReasons(asset('IMG_1234.ARW'), asset('IMG_1234.JPG'), off)).toEqual([]);
    });
  });

  describe(compareForPrimary.name, () => {
    it('should put the edited copy first, then the JPEG over the raw file', () => {
      expect(order(asset('IMG_1234.DNG'), asset('IMG_1234.HEIC'), asset('IMG_E1234.HEIC'))).toEqual([
        'IMG_E1234.HEIC',
        'IMG_1234.HEIC',
        'IMG_1234.DNG',
      ]);
    });

    it('should then prefer favorites, ratings, pixels, and the earliest', () => {
      const later = new Date(taken.getTime() + 1000);
      expect(order(asset('A.JPG', { fileCreatedAt: later }), asset('B.JPG'))).toEqual(['B.JPG', 'A.JPG']);
      expect(order(asset('A.JPG'), asset('B.JPG', { width: 8000 }))).toEqual(['B.JPG', 'A.JPG']);
      expect(order(asset('A.JPG', { width: 8000 }), asset('B.JPG', { rating: 4 }))).toEqual(['B.JPG', 'A.JPG']);
      expect(order(asset('A.JPG', { rating: 5 }), asset('B.JPG', { isFavorite: true }))).toEqual(['B.JPG', 'A.JPG']);
    });
  });

  describe(shouldReplacePrimary.name, () => {
    it('should give the cover to an edited copy, or to a JPEG over a raw file, and nothing else', () => {
      expect(shouldReplacePrimary(asset('IMG_E1234.HEIC'), asset('IMG_1234.HEIC'))).toBe(true);
      expect(shouldReplacePrimary(asset('CAM1.JPG'), asset('CAM1.ARW'))).toBe(true);
      expect(shouldReplacePrimary(asset('CAM1.ARW'), asset('CAM1.JPG'))).toBe(false);
      expect(shouldReplacePrimary(asset('B.JPG', { isFavorite: true }), asset('A.JPG'))).toBe(false);
      expect(shouldReplacePrimary(asset('IMG_1234.JPG'), asset('IMG_E1234.DNG'))).toBe(false);
    });
  });
});
