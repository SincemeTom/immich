import { extname } from 'node:path';
import { VISION_LABELS } from 'src/utils/vision-labels.js';

/** the tags content analysis gives a photo are under this one, so that they can be told apart and removed together */
export const AUTO_TAG_ROOT = '自动';
export const SCREENSHOT_TAG = `${AUTO_TAG_ROOT}/截图`;
export const QR_CODE_TAG = `${AUTO_TAG_ROOT}/文档/二维码`;
export const DOCUMENT_TAG = `${AUTO_TAG_ROOT}/文档`;
export const TABLE_TAG = `${AUTO_TAG_ROOT}/文档/表格`;
export const SMUDGE_TAG = `${AUTO_TAG_ROOT}/质量/镜头脏污`;
/** a photo analyzed by an earlier version is analyzed again */
export const CONTENT_ANALYSIS_VERSION = 1;

/** what every Mac does, on a photo or a video's preview */
export const BASE_TASKS = ['classify', 'aesthetics', 'animals', 'barcodes'] as const;
/** what macOS 26 adds, on a photo or a video's preview; speech, on a video itself */
export const MACOS_26_IMAGE_TASKS = ['documents', 'smudge'] as const;
export const SPEECH_TASK = 'speech';
/** the languages speech recognition is offered in, in the settings */
export const SPEECH_LANGUAGES = ['zh-CN', 'zh-HK', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'] as const;

/**
 * How sure Vision has to be of a document, and how much of one it has to find, for "自动/文档": a receipt, a page,
 * a sign with a paragraph or two. Set on the research's documents (m4-vision-research.md); to be checked on macOS 26.
 */
export const DOCUMENT_MIN_CONFIDENCE = 0.8;
/** how likely a smudged lens has to be for "自动/质量/镜头脏污": high, since a false one would be a slight */
export const SMUDGE_MIN_CONFIDENCE = 0.9;
/** how much better a photo's aesthetics score has to be to become its automatic stack's cover instead */
export const COVER_MIN_GAIN = 0.05;
/**
 * The classifier's confidence a label needs to become a tag. At 0.5, the objects it names are mostly right, and
 * broad labels are rarer (macos/verification/m4-vision-research.md, section 3).
 */
export const LABEL_MIN_CONFIDENCE = 0.5;
/** the most label tags one photo gets: the most specific, the most confident first */
export const MAX_LABEL_TAGS = 5;

export type VisionTask = (typeof BASE_TASKS)[number] | (typeof MACOS_26_IMAGE_TASKS)[number] | typeof SPEECH_TASK;
export type VisionError = { error: string };
export type VisionLabel = { label: string; confidence: number };
export type VisionDocument = {
  count: number;
  confidence?: number;
  lines?: number;
  paragraphs?: number;
  tables?: number;
  lists?: number;
  title?: string;
};
export type SpeechSegment = { start: number; end: number; text: string };
export type VisionSpeech = { audio: boolean; seconds: number; language: string; segments: SpeechSegment[] };
export type VisionResult = {
  id: string;
  error?: string;
  ms?: number;
  classify?: VisionLabel[] | VisionError;
  aesthetics?: VisionError | { score: number; utility: boolean };
  animals?: VisionLabel[] | VisionError;
  barcodes?: { payload: string; symbology: string }[] | VisionError;
  documents?: VisionDocument | VisionError;
  smudge?: VisionError | { confidence: number };
  speech?: VisionError | VisionSpeech;
};
/** what `immich-vision capabilities` says */
export type VisionCapabilities = { version: number; macos: string; features: string[] };

/** the tasks a photo, or a video, gets on this Mac: those it can do, speech if the settings say so */
export const getContentTasks = (
  features: string[],
  { isVideo, speech }: { isVideo: boolean; speech: boolean },
): { image: VisionTask[]; video: VisionTask[] } => {
  const image = [...BASE_TASKS, ...MACOS_26_IMAGE_TASKS].filter((task) => features.includes(task));
  const video: VisionTask[] = isVideo && speech && features.includes(SPEECH_TASK) ? [SPEECH_TASK] : [];
  return { image, video };
};

/** whether Vision found a document worth the tag: sure of it, with a table, paragraphs or a few lines of text */
export const isDocument = (document?: VisionDocument) =>
  !!document &&
  document.count > 0 &&
  (document.confidence ?? 0) >= DOCUMENT_MIN_CONFIDENCE &&
  ((document.tables ?? 0) > 0 || (document.paragraphs ?? 0) >= 2 || (document.lines ?? 0) >= 5);

/** the words of a video, as one text to search: its segments in order */
export const getTranscriptText = (segments: SpeechSegment[] = []) =>
  segments
    .map(({ text }) => text.trim())
    .filter(Boolean)
    .join(' ');

export const succeeded = <T>(value: T | VisionError | undefined): T | undefined =>
  value === undefined || (typeof value === 'object' && value !== null && 'error' in value) ? undefined : (value as T);

const ANIMALS: Record<string, string> = { Cat: '动物/猫', Dog: '动物/狗' };

/**
 * The tag paths the classifier's labels give, under AUTO_TAG_ROOT: those confident enough, without the ones another
 * is under ("动物" when there is "动物/猫", which the tag tree implies), at most MAX_LABEL_TAGS.
 */
export const getLabelTags = (labels: VisionLabel[] = [], animals: VisionLabel[] = []): string[] => {
  const confidence = new Map<string, number>();
  const add = (path: string | null | undefined, value: number) => {
    if (path && value >= LABEL_MIN_CONFIDENCE && value > (confidence.get(path) ?? 0)) {
      confidence.set(path, value);
    }
  };
  for (const { label, confidence: value } of labels) {
    add(VISION_LABELS.get(label), value);
  }
  for (const { label, confidence: value } of animals) {
    add(ANIMALS[label], value);
  }
  const paths = confidence.keys().toArray();
  return paths
    .filter((path) => paths.every((other) => !other.startsWith(`${path}/`)))
    .sort((a, b) => b.split('/').length - a.split('/').length || confidence.get(b)! - confidence.get(a)!)
    .slice(0, MAX_LABEL_TAGS)
    .map((path) => `${AUTO_TAG_ROOT}/${path}`);
};

/** the screens of the last years' phones, tablets and Macs, and common monitors, as `width x height` */
const SCREEN_SIZES = new Set(
  [
    // iPhone
    [640, 1136],
    [750, 1334],
    [828, 1792],
    [1080, 1920],
    [1125, 2436],
    [1170, 2532],
    [1179, 2556],
    [1206, 2622],
    [1242, 2208],
    [1242, 2688],
    [1260, 2736],
    [1284, 2778],
    [1290, 2796],
    [1320, 2868],
    // Android
    [720, 1600],
    [1080, 2160],
    [1080, 2244],
    [1080, 2280],
    [1080, 2340],
    [1080, 2400],
    [1080, 2412],
    [1200, 2640],
    [1200, 2670],
    [1220, 2712],
    [1224, 2700],
    [1240, 2772],
    [1256, 2808],
    [1260, 2800],
    [1264, 2780],
    [1272, 2800],
    [1440, 2560],
    [1440, 3088],
    [1440, 3120],
    [1440, 3168],
    [1440, 3200],
    // iPad
    [1488, 2266],
    [1536, 2048],
    [1620, 2160],
    [1640, 2360],
    [1668, 2224],
    [1668, 2388],
    [1668, 2420],
    [2048, 2732],
    [2064, 2752],
    // Mac and monitors
    [1440, 900],
    [1680, 1050],
    [1920, 1080],
    [1920, 1200],
    [2560, 1440],
    [2560, 1600],
    [2560, 1664],
    [2880, 1800],
    [2880, 1864],
    [2940, 1912],
    [3024, 1964],
    [3420, 2224],
    [3456, 2234],
    [3840, 2160],
    [5120, 2880],
    [6016, 3384],
  ].flatMap(([width, height]) => [`${width}x${height}`, `${height}x${width}`]),
);

/** the names screenshots are given: Android, macOS, Windows, in English or Chinese */
const SCREENSHOT_NAME = /^(screenshot|screen shot|截屏|屏幕截图|截图|屏幕快照)/i;

export type ScreenshotInput = {
  originalFileName: string;
  make?: string | null;
  model?: string | null;
  width?: number | null;
  height?: number | null;
  labels?: VisionLabel[];
};

/**
 * Whether a photo is a screenshot: named as one; or with nothing of a camera in its metadata and a PNG, or the size of
 * a screen, or one the classifier sees as a screenshot. A camera's photo has the camera in its metadata, and a
 * picture saved from the web or a chat rarely is a PNG of a screen's size: in the research's two libraries none of
 * their 125 photos was taken for one (macos/verification/m4-vision-research.md, section 4).
 */
export const isScreenshot = ({ originalFileName, make, model, width, height, labels = [] }: ScreenshotInput) => {
  if (SCREENSHOT_NAME.test(originalFileName)) {
    return true;
  }
  if (make || model) {
    return false;
  }
  const isPng = extname(originalFileName).toLowerCase() === '.png';
  const isScreenSized = !!width && !!height && SCREEN_SIZES.has(`${width}x${height}`);
  const classified = labels.some(
    ({ label, confidence }) => label === 'screenshot' && confidence >= LABEL_MIN_CONFIDENCE,
  );
  return isPng || isScreenSized || classified;
};

export const hasQrCode = (barcodes: { symbology: string }[] = []) =>
  barcodes.some(({ symbology }) => symbology.toLowerCase().includes('qr'));
