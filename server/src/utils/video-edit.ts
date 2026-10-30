import { compose } from 'transformation-matrix';
import { AssetEditAction, AssetEditActionItem, MirrorAxis } from 'src/dtos/editing.dto.js';
import { createAffineMatrix } from 'src/utils/transform.js';

/**
 * How a video is to be shown: rotated counter-clockwise by `rotation` degrees, then flipped horizontally if `hflip`.
 * This is the display matrix of an MP4 or MOV, as ffmpeg's -display_rotation and -display_hflip set it, so a video is
 * rotated or mirrored by rewriting it, the stream copied untouched, rather than by encoding it again.
 */
export interface VideoDisplayTransform {
  rotation: 0 | 90 | 180 | 270;
  hflip: boolean;
}

/** Videos take the edits a display matrix can express: rotating and mirroring, not cropping */
export const isVideoEdit = (edit: AssetEditActionItem) =>
  edit.action === AssetEditAction.Rotate || edit.action === AssetEditAction.Mirror;

const key = (edits: AssetEditActionItem[]) => {
  const { a, b, c, d } = createAffineMatrix(edits);
  return [a, b, c, d].map((value) => Math.round(value)).join(',');
};

const rotate = (angle: number): AssetEditActionItem => ({ action: AssetEditAction.Rotate, parameters: { angle } });
const mirror: AssetEditActionItem = { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } };

/**
 * The eight display transforms, by the matrix the image edits apply for the same picture, found by comparing the
 * frames of videos so rewritten with the frame the image pipeline edits (macos/verification/m1-video-rotation.md):
 * a display rotation of r counter-clockwise is the edit "rotate (360 - r)", which turns clockwise, and with a flip it
 * is "mirror horizontally, then rotate r"
 */
const DISPLAY_TRANSFORMS = new Map<string, VideoDisplayTransform>(
  ([0, 90, 180, 270] as const).flatMap((rotation) => [
    [key([rotate((360 - rotation) % 360)]), { rotation, hflip: false }],
    [key([mirror, rotate(rotation)]), { rotation, hflip: true }],
  ]),
);

/**
 * The display transform of a video whose file is shown rotated `sourceRotation` degrees counter-clockwise (ffprobe's
 * rotation: -90 for a portrait iPhone video) once the edits are applied to what it shows
 */
export const getVideoDisplayTransform = (
  sourceRotation: number,
  edits: AssetEditActionItem[],
): VideoDisplayTransform => {
  const source = createAffineMatrix([rotate((((360 - sourceRotation) % 360) + 360) % 360)]);
  // in this order, found by comparing frames like the table: the other fails as soon as a mirror meets a rotated source
  const total = compose(source, createAffineMatrix(edits.filter((edit) => isVideoEdit(edit))));
  const transform = DISPLAY_TRANSFORMS.get(
    [total.a, total.b, total.c, total.d].map((value) => Math.round(value)).join(','),
  );
  if (!transform) {
    throw new Error(`No display transform for ${JSON.stringify(edits)} on a video rotated ${sourceRotation}`);
  }
  return transform;
};

/** ffmpeg input options that show the input with this transform, in place of its own display matrix */
export const getDisplayOptions = ({ rotation, hflip }: VideoDisplayTransform) => [
  '-display_rotation',
  String(rotation),
  ...(hflip ? ['-display_hflip'] : []),
];

/** The rotation as VideoStreamInfo takes it: counter-clockwise, from -90 to 180, as ffprobe reports it */
export const toStreamRotation = ({ rotation }: VideoDisplayTransform) => (rotation === 270 ? -90 : rotation);

/**
 * A video stream as its edits show it, and the input options that make ffmpeg read it so: for transcoding the
 * original, whose packets the stream's keyframes and segments are counted in
 */
export const withVideoEdits = <T extends { rotation: number }>(videoStream: T, edits: AssetEditActionItem[] = []) => {
  if (edits.every((edit) => !isVideoEdit(edit))) {
    return { videoStream, inputOptions: [] as string[] };
  }
  const display = getVideoDisplayTransform(videoStream.rotation, edits);
  return {
    videoStream: { ...videoStream, rotation: toStreamRotation(display) },
    inputOptions: getDisplayOptions(display),
  };
};
