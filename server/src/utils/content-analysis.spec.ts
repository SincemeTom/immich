import { AssetType } from 'src/enum.js';
import { isBetterCover } from 'src/utils/auto-stack.js';
import {
  MAX_LABEL_TAGS,
  getContentTasks,
  getLabelTags,
  getTranscriptText,
  hasQrCode,
  isDocument,
  isScreenshot,
  succeeded,
} from 'src/utils/content-analysis.js';
import { VISION_LABELS } from 'src/utils/vision-labels.js';

describe('content analysis', () => {
  describe('VISION_LABELS', () => {
    it('has every label of the classifier, each a path in Chinese or left out', () => {
      expect(VISION_LABELS.size).toBe(1303);
      for (const [label, path] of VISION_LABELS) {
        expect(label).toMatch(/^[a-z0-9_]+$/);
        if (path !== null) {
          expect(path).toMatch(/^[^\s/]+(\/[^\s/]+)*$/);
        }
      }
    });

    it('leaves out the broad labels', () => {
      for (const label of ['structure', 'outdoor', 'sky', 'wood_processed', 'utensil', 'screenshot']) {
        expect(VISION_LABELS.get(label)).toBeNull();
      }
    });
  });

  describe('getLabelTags', () => {
    it('tags the most specific of the confident labels', () => {
      const labels = [
        { label: 'animal', confidence: 0.95 },
        { label: 'cat', confidence: 0.9 },
        { label: 'feline', confidence: 0.9 },
        { label: 'outdoor', confidence: 0.9 },
        { label: 'grass', confidence: 0.6 },
        { label: 'flower', confidence: 0.3 },
      ];

      expect(getLabelTags(labels)).toEqual(['自动/动物/猫', '自动/植物/草地']);
    });

    it('takes the cats and dogs the animal recognizer finds', () => {
      expect(getLabelTags([], [{ label: 'Dog', confidence: 0.8 }])).toEqual(['自动/动物/狗']);
      expect(getLabelTags([{ label: 'corgi', confidence: 0.7 }], [{ label: 'Dog', confidence: 0.8 }])).toEqual([
        '自动/动物/狗/柯基',
      ]);
    });

    it('gives a photo no more than a few', () => {
      const labels = ['pizza', 'beer', 'salad', 'sushi', 'ramen', 'cake', 'coffee'].map((label) => ({
        label,
        confidence: 0.8,
      }));

      expect(getLabelTags(labels)).toHaveLength(MAX_LABEL_TAGS);
    });

    it('skips labels it does not know', () => {
      expect(getLabelTags([{ label: 'a_label_from_a_newer_macos', confidence: 0.99 }])).toEqual([]);
    });
  });

  describe('isScreenshot', () => {
    it('takes a PNG of no camera', () => {
      expect(isScreenshot({ originalFileName: 'IMG_0001.PNG', width: 1179, height: 2556 })).toBe(true);
      expect(isScreenshot({ originalFileName: 'drawing.png', width: 800, height: 600 })).toBe(true);
    });

    it("takes a screen's size, of no camera, in any format", () => {
      expect(isScreenshot({ originalFileName: 'IMG_0002.JPG', width: 1290, height: 2796 })).toBe(true);
      expect(isScreenshot({ originalFileName: 'IMG_0002.JPG', width: 2796, height: 1290 })).toBe(true);
    });

    it('takes one named as a screenshot, whatever its metadata', () => {
      expect(isScreenshot({ originalFileName: 'Screenshot_20260101-101010.jpg', make: 'Xiaomi' })).toBe(true);
      expect(isScreenshot({ originalFileName: '截屏2026-11-01 10.10.10.png' })).toBe(true);
      expect(isScreenshot({ originalFileName: '屏幕截图 2026-11-01 101010.png' })).toBe(true);
    });

    it('takes one the classifier sees as a screenshot, of no camera', () => {
      const labels = [{ label: 'screenshot', confidence: 0.7 }];
      expect(isScreenshot({ originalFileName: 'wx_camera_1730000000.jpg', width: 1000, height: 2165, labels })).toBe(
        true,
      );
      expect(isScreenshot({ originalFileName: 'IMG_0003.HEIC', make: 'Apple', model: 'iPhone 16', labels })).toBe(
        false,
      );
    });

    it("leaves a camera's photo alone", () => {
      expect(
        isScreenshot({
          originalFileName: 'IMG_0004.PNG',
          make: 'Apple',
          model: 'iPhone 16',
          width: 1179,
          height: 2556,
        }),
      ).toBe(false);
      expect(isScreenshot({ originalFileName: 'DSC00001.JPG', make: 'SONY', width: 6000, height: 4000 })).toBe(false);
    });

    it('leaves alone a photo of no camera that looks like none', () => {
      expect(isScreenshot({ originalFileName: 'download.jpg', width: 1200, height: 800 })).toBe(false);
    });
  });

  describe('hasQrCode', () => {
    it('tells a QR code from other barcodes', () => {
      expect(hasQrCode([{ symbology: 'qr' }])).toBe(true);
      expect(hasQrCode([{ symbology: 'ean13' }])).toBe(false);
      expect(hasQrCode()).toBe(false);
    });
  });

  describe('getContentTasks', () => {
    const macos15 = ['classify', 'aesthetics', 'animals', 'barcodes'];
    const macos26 = [...macos15, 'documents', 'smudge', 'speech'];

    it("makes only the requests this Mac has: macOS 26's on macOS 26", () => {
      expect(getContentTasks(macos15, { isVideo: true, speech: true })).toEqual({ image: macos15, video: [] });
      expect(getContentTasks(macos26, { isVideo: false, speech: true })).toEqual({
        image: [...macos15, 'documents', 'smudge'],
        video: [],
      });
      expect(getContentTasks(macos26, { isVideo: true, speech: true }).video).toEqual(['speech']);
    });

    it('listens to a video only with speech on', () => {
      expect(getContentTasks(macos26, { isVideo: true, speech: false }).video).toEqual([]);
    });

    it('leaves out a request it does not know', () => {
      expect(getContentTasks(['classify', 'something-newer'], { isVideo: false, speech: true }).image).toEqual([
        'classify',
      ]);
    });
  });

  describe('isDocument', () => {
    it('takes a page, a receipt, a table, of which Vision is sure', () => {
      expect(isDocument({ count: 1, confidence: 0.9, lines: 12, paragraphs: 3, tables: 0 })).toBe(true);
      expect(isDocument({ count: 1, confidence: 0.85, lines: 4, paragraphs: 1, tables: 1 })).toBe(true);
    });

    it('leaves a sign with a word or two, or what Vision is unsure of', () => {
      expect(isDocument({ count: 1, confidence: 0.95, lines: 2, paragraphs: 1, tables: 0 })).toBe(false);
      expect(isDocument({ count: 1, confidence: 0.5, lines: 30, paragraphs: 5, tables: 1 })).toBe(false);
      expect(isDocument({ count: 0 })).toBe(false);
      expect(isDocument()).toBe(false);
    });
  });

  describe('getTranscriptText', () => {
    it('joins what is said, in order', () => {
      expect(
        getTranscriptText([
          { start: 0, end: 1, text: ' 生日快乐 ' },
          { start: 1, end: 2, text: '' },
          { start: 2, end: 3, text: 'happy birthday' },
        ]),
      ).toBe('生日快乐 happy birthday');
      expect(getTranscriptText()).toBe('');
    });
  });

  describe('isBetterCover', () => {
    const photo = {
      id: 'a',
      type: AssetType.Image,
      originalFileName: 'IMG_0001.HEIC',
      originalPath: '/a',
      fileCreatedAt: new Date(0),
      isFavorite: false,
      width: 100,
      height: 100,
      dateTimeOriginal: null,
      model: null,
      rating: null,
      autoStackId: null,
    };

    it('takes the better taken photo, by a margin', () => {
      expect(isBetterCover({ ...photo, aestheticScore: 0.5 }, { ...photo, aestheticScore: 0.2 }, 0.05)).toBe(true);
      expect(isBetterCover({ ...photo, aestheticScore: 0.22 }, { ...photo, aestheticScore: 0.2 }, 0.05)).toBe(false);
      expect(isBetterCover({ ...photo, aestheticScore: 0.5 }, { ...photo, aestheticScore: null }, 0.05)).toBe(false);
    });

    it('keeps to the rules first: a favorite, a JPEG over its raw file', () => {
      expect(
        isBetterCover({ ...photo, aestheticScore: 0.9 }, { ...photo, isFavorite: true, aestheticScore: 0.1 }, 0.05),
      ).toBe(false);
      expect(
        isBetterCover(
          { ...photo, originalFileName: 'A.ARW', aestheticScore: 0.9 },
          { ...photo, originalFileName: 'A.JPG', aestheticScore: 0.1 },
          0.05,
        ),
      ).toBe(false);
      expect(isBetterCover({ ...photo, rating: 5 }, { ...photo, aestheticScore: 0.9 }, 0.05)).toBe(true);
    });
  });

  describe('succeeded', () => {
    it('drops a request that failed', () => {
      expect(succeeded({ error: 'invalidImage' })).toBeUndefined();
      expect(succeeded([{ label: 'cat', confidence: 0.9 }])).toEqual([{ label: 'cat', confidence: 0.9 }]);
      expect(succeeded(undefined)).toBeUndefined();
    });
  });
});
