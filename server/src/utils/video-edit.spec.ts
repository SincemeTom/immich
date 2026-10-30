import { AssetEditAction, AssetEditActionItem, MirrorAxis } from 'src/dtos/editing.dto.js';
import { getDisplayOptions, getVideoDisplayTransform, withVideoEdits } from 'src/utils/video-edit.js';

const rotate = (angle: number): AssetEditActionItem => ({ action: AssetEditAction.Rotate, parameters: { angle } });
const mirror = (axis: MirrorAxis): AssetEditActionItem => ({ action: AssetEditAction.Mirror, parameters: { axis } });

describe('video edits', () => {
  // the frames of videos so rewritten matched the image edits for every one of these and of a source rotated 90,
  // -90 and 180 (macos/verification/m1-video-rotation.md); these keep the table and the order of composing
  it.each([
    { source: 0, edits: [rotate(90)], expected: { rotation: 270, hflip: false } },
    { source: 0, edits: [rotate(270)], expected: { rotation: 90, hflip: false } },
    { source: 0, edits: [rotate(180)], expected: { rotation: 180, hflip: false } },
    { source: 0, edits: [mirror(MirrorAxis.Horizontal)], expected: { rotation: 0, hflip: true } },
    { source: 0, edits: [mirror(MirrorAxis.Vertical)], expected: { rotation: 180, hflip: true } },
    { source: 0, edits: [mirror(MirrorAxis.Horizontal), rotate(90)], expected: { rotation: 90, hflip: true } },
    { source: -90, edits: [rotate(90)], expected: { rotation: 180, hflip: false } },
    { source: 90, edits: [rotate(90)], expected: { rotation: 0, hflip: false } },
    { source: -90, edits: [mirror(MirrorAxis.Horizontal)], expected: { rotation: 270, hflip: true } },
    { source: 180, edits: [], expected: { rotation: 180, hflip: false } },
  ])('$source° and $edits.length edits: $expected', ({ source, edits, expected }) => {
    expect(getVideoDisplayTransform(source, edits)).toEqual(expected);
  });

  it('should leave out cropping, which a display matrix cannot do', () => {
    const crop: AssetEditActionItem = {
      action: AssetEditAction.Crop,
      parameters: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(getVideoDisplayTransform(0, [crop, rotate(90)])).toEqual({ rotation: 270, hflip: false });
  });

  it('should give the ffmpeg input options', () => {
    expect(getDisplayOptions({ rotation: 90, hflip: true })).toEqual(['-display_rotation', '90', '-display_hflip']);
    expect(getDisplayOptions({ rotation: 0, hflip: false })).toEqual(['-display_rotation', '0']);
  });

  it('should give a stream as edited, or as it is', () => {
    const stream = { rotation: -90, width: 1920, height: 1080 };
    expect(withVideoEdits(stream, [])).toEqual({ videoStream: stream, inputOptions: [] });
    expect(withVideoEdits(stream, [rotate(90)])).toEqual({
      videoStream: { ...stream, rotation: 180 },
      inputOptions: ['-display_rotation', '180'],
    });
    expect(withVideoEdits(stream, [rotate(270)]).videoStream.rotation).toBe(0);
    expect(withVideoEdits({ rotation: 0 }, [rotate(90)]).videoStream.rotation).toBe(-90);
  });
});
