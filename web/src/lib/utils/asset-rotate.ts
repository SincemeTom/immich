import { AssetEditAction, type AssetEditsCreateDto } from '@immich/sdk';

type EditActions = AssetEditsCreateDto['edits'];

/**
 * The edits that turn an asset `degrees` more, clockwise, as it shows now. Edits apply in their order, crop first, and
 * an asset has one rotation at most: when no mirror follows it, turning more is turning by more; when one does, the
 * mirror reverses the turn that comes after it, so the rotation before it turns the other way.
 */
export const rotateEdits = (edits: EditActions, degrees: number): EditActions => {
  const index = edits.findIndex((edit) => edit.action === AssetEditAction.Rotate);
  const normalize = (angle: number) => (((angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;

  if (index === -1) {
    const angle = normalize(degrees);
    return angle === 0 ? edits : [...edits, { action: AssetEditAction.Rotate, parameters: { angle } }];
  }

  const mirrorsAfter = edits.slice(index + 1).filter((edit) => edit.action === AssetEditAction.Mirror).length;
  const current = edits[index].parameters as { angle: number };
  const angle = normalize(current.angle + (mirrorsAfter % 2 === 0 ? degrees : -degrees));
  if (angle === 0) {
    return edits.filter((_, i) => i !== index);
  }
  return edits.map((edit, i) => (i === index ? { action: AssetEditAction.Rotate, parameters: { angle } } : edit));
};
