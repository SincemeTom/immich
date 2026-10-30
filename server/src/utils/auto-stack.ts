import { dirname } from 'node:path';
import type { AutoStackPreferences } from 'src/types.js';
import { AssetType } from 'src/enum.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/** Why two assets belong in one stack, strongest first */
export enum AutoStackReason {
  /** the camera marked them as one burst */
  Burst = 'burst',
  /** a raw file and the JPEG or HEIC the camera saved with it */
  RawJpeg = 'raw-jpeg',
  /** an edited copy and its original */
  Edited = 'edited',
  /** they look alike, and were taken within seconds of each other */
  Similar = 'similar',
}

export interface AutoStackAsset {
  id: string;
  type: AssetType;
  originalFileName: string;
  originalPath: string;
  fileCreatedAt: Date;
  isFavorite: boolean;
  width: number | null;
  height: number | null;
  dateTimeOriginal: Date | null;
  model: string | null;
  rating: number | null;
  autoStackId: string | null;
}

export interface AutoStackCandidate extends AutoStackAsset {
  stackId: string | null;
  /** CLIP distance to the asset, when both have an embedding */
  distance: number | null;
}

const getStem = (fileName: string) => fileName.replace(/\.[^.]*$/, '');

/**
 * The name of the original an edited copy was made from: IMG_1234 for IMG_E1234 (iPhone, and Synology Photos and
 * iCloud exports of it), IMG_1234 for IMG_1234-edited (Google Photos), IMG_1234 for "IMG_1234 (edited)"
 */
export const getEditedOriginal = (stem: string): string | undefined => {
  const iphone = /^([A-Za-z]{3})_E(\d{4,})$/.exec(stem);
  if (iphone) {
    return `${iphone[1]}_${iphone[2]}`;
  }
  const suffix = /^(.+?)(?:-edited| \(edited\))$/i.exec(stem);
  return suffix?.[1];
};

/** The names, lowercased and without extension, that files stacked with this one by name may have */
export const getAutoStackNameKeys = (fileName: string) => {
  const stem = getStem(fileName);
  const keys = new Set([stem]);
  const original = getEditedOriginal(stem);
  if (original) {
    keys.add(original);
  } else {
    const iphone = /^([A-Za-z]{3})_(\d{4,})$/.exec(stem);
    if (iphone) {
      keys.add(`${iphone[1]}_E${iphone[2]}`);
    }
    keys.add(`${stem}-edited`).add(`${stem} (edited)`);
  }
  return [...keys].map((key) => key.toLowerCase());
};

const isRaw = (asset: AutoStackAsset) => mimeTypes.isRaw(asset.originalFileName);

const isEditedCopy = (asset: AutoStackAsset) => !!getEditedOriginal(getStem(asset.originalFileName));

/**
 * Whether two files with matching names were saved together: in one folder (an external library, or the storage
 * template), or, uploaded into folders of their own, taken at the same moment by the same camera
 */
const isSameShot = (a: AutoStackAsset, b: AutoStackAsset) => {
  if (dirname(a.originalPath) === dirname(b.originalPath)) {
    return true;
  }
  return (
    !!a.dateTimeOriginal &&
    !!b.dateTimeOriginal &&
    Math.abs(new Date(a.dateTimeOriginal).getTime() - new Date(b.dateTimeOriginal).getTime()) < 1000 &&
    (a.model ?? '') === (b.model ?? '')
  );
};

/** Why a candidate belongs in a stack with the asset, under these preferences; none when it doesn't */
export const getAutoStackReasons = (
  asset: AutoStackAsset,
  candidate: AutoStackCandidate,
  preferences: AutoStackPreferences,
): AutoStackReason[] => {
  const reasons: AutoStackReason[] = [];

  if (preferences.burst && asset.autoStackId && asset.autoStackId === candidate.autoStackId) {
    reasons.push(AutoStackReason.Burst);
  }

  const stem = getStem(asset.originalFileName).toLowerCase();
  const candidateStem = getStem(candidate.originalFileName).toLowerCase();

  if (
    preferences.rawJpeg &&
    asset.type === AssetType.Image &&
    candidate.type === AssetType.Image &&
    stem === candidateStem &&
    isRaw(asset) !== isRaw(candidate) &&
    isSameShot(asset, candidate)
  ) {
    reasons.push(AutoStackReason.RawJpeg);
  }

  if (preferences.edited && asset.type === candidate.type) {
    const original = getEditedOriginal(getStem(asset.originalFileName))?.toLowerCase();
    const candidateOriginal = getEditedOriginal(getStem(candidate.originalFileName))?.toLowerCase();
    if ((original === candidateStem || candidateOriginal === stem) && isSameShot(asset, candidate)) {
      reasons.push(AutoStackReason.Edited);
    }
  }

  if (
    preferences.similar &&
    asset.type === AssetType.Image &&
    candidate.type === AssetType.Image &&
    candidate.distance !== null
  ) {
    const seconds =
      Math.abs(new Date(asset.fileCreatedAt).getTime() - new Date(candidate.fileCreatedAt).getTime()) / 1000;
    // alike and taken within seconds; or, whenever taken, all but the same
    if (
      (candidate.distance <= preferences.maxDistance && seconds <= preferences.maxSeconds) ||
      (preferences.anytime && candidate.distance <= preferences.anytimeDistance)
    ) {
      reasons.push(AutoStackReason.Similar);
    }
  }

  return reasons;
};

/**
 * Orders assets for the cover of their stack: an edited copy over its original, a JPEG or HEIC over its raw file
 * (the picture as the camera or the editor made it), then favorites, higher ratings, more pixels, and the earliest
 */
export const compareForPrimary = (a: AutoStackAsset, b: AutoStackAsset) =>
  Number(isEditedCopy(b)) - Number(isEditedCopy(a)) ||
  Number(isRaw(a)) - Number(isRaw(b)) ||
  Number(b.isFavorite) - Number(a.isFavorite) ||
  (b.rating ?? 0) - (a.rating ?? 0) ||
  (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) ||
  new Date(a.fileCreatedAt).getTime() - new Date(b.fileCreatedAt).getTime();

/** Whether an asset joining a stack should become its cover: an edited copy, or a JPEG with a raw file as cover */
export const shouldReplacePrimary = (asset: AutoStackAsset, primary: AutoStackAsset) =>
  (isEditedCopy(asset) && !isEditedCopy(primary)) ||
  (isEditedCopy(asset) === isEditedCopy(primary) && !isRaw(asset) && isRaw(primary));
