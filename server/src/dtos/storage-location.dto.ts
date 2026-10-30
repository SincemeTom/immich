import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QueueNameSchema, StorageFolder } from 'src/enum.js';

const RelocatableFolderSchema = z
  .enum([StorageFolder.Thumbnails, StorageFolder.EncodedVideo, StorageFolder.Backups])
  .describe('A folder of the media location that can be kept on a network share')
  .meta({ id: 'StorageLocationFolder' });

const StorageLocationOnShareSchema = z
  .object({
    shareId: z.uuidv4().describe('Network share ID'),
    shareName: z.string().describe('Network share name'),
    path: z.string().describe('Folder on the share, relative to its top level'),
  })
  .meta({ id: 'StorageLocationOnShareDto' });

const StorageLocationMigrationSchema = z
  .object({
    moved: z.int().describe('Files moved so far'),
    remaining: z.int().describe('Files left to move'),
    failed: z.int().describe('Files that could not be moved, tried again later'),
  })
  .meta({ id: 'StorageLocationMigrationDto' });

const StorageLocationItemSchema = z
  .object({
    folder: RelocatableFolderSchema.optional(),
    userId: z.uuidv4().optional().describe("User ID, for where a user's originals are kept"),
    userName: z.string().optional().describe('User name'),
    userEmail: z.string().optional().describe('User email'),
    location: StorageLocationOnShareSchema.optional().describe('The share it is kept on; the media location if not'),
    absolutePath: z.string().describe('Where its files go on this Mac'),
    suggestedPath: z.string().describe('A folder on a share to suggest for it'),
    available: z.boolean().describe('Whether it can be used now'),
    message: z.string().optional().describe('Why it cannot be used'),
    pendingFrom: z.array(z.string()).describe('Folders its files are still being moved out of'),
    migration: StorageLocationMigrationSchema.optional(),
  })
  .meta({ id: 'StorageLocationItemDto' });

const StorageLocationsResponseSchema = z
  .object({
    folders: z.array(StorageLocationItemSchema).describe('Thumbnails, encoded videos and database backups'),
    users: z.array(StorageLocationItemSchema).describe("Each user's originals"),
    pausedQueues: z.array(QueueNameSchema).describe('Queues paused while a location cannot be used'),
    storageTemplateEnabled: z.boolean().describe('Whether the storage template is on: originals only move with it'),
    checkedAt: z.string().optional().describe('When the locations were last checked'),
  })
  .meta({ id: 'StorageLocationsResponseDto' });

const StorageLocationUpdateSchema = z
  .object({
    shareId: z.uuidv4().nullable().describe('Network share to keep it on; null for the media location'),
    path: z.string().trim().max(1024).optional().describe('Folder on the share, relative to its top level'),
  })
  .meta({ id: 'StorageLocationUpdateDto' });

const StorageLocationFolderParamSchema = z.object({ folder: RelocatableFolderSchema });

export class StorageLocationsResponseDto extends createZodDto(StorageLocationsResponseSchema) {}
export class StorageLocationItemDto extends createZodDto(StorageLocationItemSchema) {}
export class StorageLocationUpdateDto extends createZodDto(StorageLocationUpdateSchema) {}
export class StorageLocationFolderParamDto extends createZodDto(StorageLocationFolderParamSchema) {}
