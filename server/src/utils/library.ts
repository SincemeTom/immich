import { constants } from 'node:fs';
import type { StorageRepository } from 'src/repositories/storage.repository.js';

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
