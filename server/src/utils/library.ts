import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StorageRepository } from 'src/repositories/storage.repository.js';
import { MARKER_FILE } from 'src/utils/storage-location.js';

/**
 * Whether Immich sees an external library's files now: every import path a readable folder with something in it. A
 * NAS share that is not mounted leaves an empty folder, or none, and every file in it offline; then an offline file
 * may well still exist, and its asset (its albums, faces, favorites) must not be deleted for being offline.
 */
export const isLibraryReachable = async (storage: StorageRepository, importPaths: string[]): Promise<boolean> => {
  if (importPaths.length === 0) {
    return false;
  }

  for (const importPath of importPaths) {
    try {
      const stat = await storage.stat(importPath);
      if (!stat.isDirectory() || !(await storage.checkFileExists(importPath, constants.R_OK))) {
        return false;
      }
      const entries = await storage.readdir(importPath);
      if (entries.length === 0) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
};

/** Whether a file is in an import path: at it, or anywhere under it */
export const isWithinImportPath = (filePath: string, importPath: string) => {
  const folder = importPath.endsWith('/') ? importPath : `${importPath}/`;
  return filePath === importPath || filePath.startsWith(folder);
};

/**
 * Whether a file is in a folder Immich keeps its own files in, as its marker tells: a user's originals on the NAS, say.
 * Found by the marker, not the path, so that the folder is left out however its share is reached: at /Volumes as well
 * as where Immich mounts it. The folders asked about are remembered, for one crawl.
 */
export const createImmichFolderCheck = (storage: StorageRepository, importPaths: string[]) => {
  const marked = new Map<string, Promise<boolean>>();
  const isMarked = (folder: string) => {
    let answer = marked.get(folder);
    if (!answer) {
      answer = storage.checkFileExists(join(folder, MARKER_FILE)).catch(() => false);
      marked.set(folder, answer);
    }
    return answer;
  };

  return async (filePath: string) => {
    const root = importPaths.find((importPath) => isWithinImportPath(filePath, importPath));
    if (!root) {
      return false;
    }
    for (let folder = dirname(filePath); isWithinImportPath(folder, root); folder = dirname(folder)) {
      if (await isMarked(folder)) {
        return true;
      }
      if (folder === dirname(folder)) {
        break;
      }
    }
    return false;
  };
};
