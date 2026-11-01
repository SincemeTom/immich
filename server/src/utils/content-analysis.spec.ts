import { MAX_LABEL_TAGS, getLabelTags, hasQrCode, isScreenshot, succeeded } from 'src/utils/content-analysis.js';
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

  describe('succeeded', () => {
    it('drops a request that failed', () => {
      expect(succeeded({ error: 'invalidImage' })).toBeUndefined();
      expect(succeeded([{ label: 'cat', confidence: 0.9 }])).toEqual([{ label: 'cat', confidence: 0.9 }]);
      expect(succeeded(undefined)).toBeUndefined();
    });
  });
});
