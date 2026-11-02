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
 * What "自动/文档" takes, measured on macOS 26-27 (m4-vision-content.md, section 2.4). Vision's own confidence in a
 * document is always 0 there, and it finds one in any picture, so the text it finds decides: a table; or text that
 * covers much of the picture (a page); or what the classifier sees as a document, with some text over some of it
 * (handwritten notes, a bill). A street sign, a shop's menu board, a lit name on a wall stay out.
 */
export const DOCUMENT_TABLE_MIN_CHARACTERS = 20;
export const DOCUMENT_MIN_CHARACTERS = 100;
export const DOCUMENT_PAGE_MIN_TEXT_AREA = 0.3;
export const DOCUMENT_MIN_TEXT_AREA = 0.05;
export const DOCUMENT_LABEL_MIN_CONFIDENCE = 0.3;
const DOCUMENT_LABELS = new Set(['document', 'printed_page', 'handwriting', 'receipt']);
/**
 * How likely a smudged lens has to be for "自动/质量/镜头脏污", and how sure the classifier has to be of something in
 * the picture. On macOS 26-27 a smudge gives 0.99 and more, and so does a bare wall, which the classifier sees nothing
 * in; a shallow depth of field gives up to about 0.986 (m4-vision-content.md, section 2.4).
 */
export const SMUDGE_MIN_CONFIDENCE = 0.99;
export const SMUDGE_MIN_SCENE_CONFIDENCE = 0.3;
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
  /** how many characters of text it read */
  characters?: number;
  /** how much of the picture its lines of text cover, 0 to 1 */
  textArea?: number;
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

/** whether a picture is a document worth the tag (DOCUMENT_* above), by what Vision read in it and what it sees */
export const isDocument = (document?: VisionDocument, labels: VisionLabel[] = []) => {
  if (!document || document.count === 0) {
    return false;
  }
  const characters = document.characters ?? 0;
  const textArea = document.textArea ?? 0;
  const classified = labels.some(
    ({ label, confidence }) => DOCUMENT_LABELS.has(label) && confidence >= DOCUMENT_LABEL_MIN_CONFIDENCE,
  );
  return (
    ((document.tables ?? 0) > 0 && characters >= DOCUMENT_TABLE_MIN_CHARACTERS) ||
    (characters >= DOCUMENT_MIN_CHARACTERS && textArea >= DOCUMENT_PAGE_MIN_TEXT_AREA) ||
    (characters >= DOCUMENT_MIN_CHARACTERS && textArea >= DOCUMENT_MIN_TEXT_AREA && classified)
  );
};

/** whether the lens was smudged (SMUDGE_* above): Vision is all but sure, and the classifier sees a scene */
export const isSmudged = (smudge: number | null | undefined, labels: VisionLabel[] = []) =>
  (smudge ?? 0) >= SMUDGE_MIN_CONFIDENCE &&
  labels.some(({ confidence }) => confidence >= SMUDGE_MIN_SCENE_CONFIDENCE);

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
