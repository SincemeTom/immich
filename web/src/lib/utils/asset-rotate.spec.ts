import { AssetEditAction, MirrorAxis } from '@immich/sdk';
import { rotateEdits } from '$lib/utils/asset-rotate';

const rotate = (angle: number) => ({ action: AssetEditAction.Rotate, parameters: { angle } });
const mirror = { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } };
const crop = { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 10, height: 10 } };

describe('rotateEdits', () => {
  it('should add a rotation after the other edits', () => {
    expect(rotateEdits([], 90)).toEqual([rotate(90)]);
    expect(rotateEdits([crop, mirror], -90)).toEqual([crop, mirror, rotate(270)]);
  });

  it('should turn the rotation there is', () => {
    expect(rotateEdits([crop, rotate(90)], 90)).toEqual([crop, rotate(180)]);
    expect(rotateEdits([mirror, rotate(270)], 180)).toEqual([mirror, rotate(90)]);
  });

  it('should remove a rotation turned back to none', () => {
    expect(rotateEdits([crop, rotate(90)], -90)).toEqual([crop]);
    expect(rotateEdits([rotate(270)], 90)).toEqual([]);
  });

  it('should turn a rotation a mirror follows the other way', () => {
    expect(rotateEdits([rotate(90), mirror], 90)).toEqual([mirror]);
    expect(rotateEdits([rotate(90), mirror], -90)).toEqual([rotate(180), mirror]);
  });
});
