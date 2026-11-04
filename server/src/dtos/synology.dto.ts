import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { SynologyErrorReason, isSynologySyncTime, toSynologyUrl } from 'src/utils/synology.js';

const SynologyErrorReasonSchema = z
  .enum(SynologyErrorReason)
  .describe('Why connecting to Synology, or logging in to it, failed')
  .meta({ id: 'SynologyErrorReason' });

const SynologyAccountBindSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(512)
      .refine((value) => !!toSynologyUrl(value), 'Must be an address such as https://nas.example.com:5001')
      .describe('Address of the Synology, such as https://nas.example.com:5001; HTTPS without a scheme'),
    account: z.string().trim().min(1).max(256).describe('Synology account name'),
    password: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('Password of the account. Left out, the one in the Keychain is used, if the address and account stay'),
    verifyCertificate: z
      .boolean()
      .default(true)
      .describe("Check the Synology's HTTPS certificate; turn off for a self-signed one"),
    otpCode: z
      .string()
      .trim()
      .regex(/^\d{6,8}$/, 'Must be the 6-digit code')
      .optional()
      .describe('2-step verification code, when Synology asks for one; this server is then trusted, without codes'),
  })
  .meta({ id: 'SynologyAccountBindDto' });

const SynologySyncReportSchema = z
  .object({
    startedAt: z.string().describe('When the sync started'),
    finishedAt: z.string().describe('When it finished'),
    success: z.boolean().describe('Whether it could log in and read the albums'),
    errorReason: SynologyErrorReasonSchema.optional(),
    message: z.string().optional().describe('The error, as Synology or the system reported it'),
    albums: z.int().describe('The Synology albums of the account'),
    albumsCreated: z.int().describe('Albums created in Immich'),
    albumsUpdated: z.int().describe('Albums changed: renamed, another cover, photos added or removed'),
    albumsRemoved: z.int().describe('Albums the sync created and Synology no longer has: removed, not their photos'),
    albumsEmpty: z.int().describe('Albums none of whose photos were found in the external libraries: not created'),
    albumsFailed: z.int().describe('Albums whose photos Synology did not list: left as they were'),
    items: z.int().describe("The account's own photos in its albums"),
    matched: z.int().describe("Of them, those found in the user's external libraries"),
    others: z.int().describe('Photos others added to the albums: not synced yet'),
    added: z.int().describe('Photos added to albums'),
    removed: z.int().describe('Photos removed from albums'),
    unmatchedPaths: z.array(z.string()).describe('The first photos not found, as paths in Synology Photos'),
  })
  .meta({ id: 'SynologySyncReportDto' });

const SynologyAccountResponseSchema = z
  .object({
    bound: z.boolean().describe('Whether the user bound a Synology account'),
    url: z.string().optional().describe('Address of the Synology'),
    account: z.string().optional().describe('Synology account name'),
    verifyCertificate: z.boolean().optional().describe("Whether the Synology's HTTPS certificate is checked"),
    name: z.string().optional().describe('The name Synology Photos has for the account'),
    boundAt: z.string().optional().describe('When the account was bound'),
    checkedAt: z.string().optional().describe('When the server last logged in with it'),
    albumCount: z.int().optional().describe('How many albums of its own the account had then'),
    errorReason: SynologyErrorReasonSchema.optional(),
    message: z.string().optional().describe('The last error, as Synology or the system reported it'),
    autoSync: z.boolean().optional().describe('Whether the albums are synced every day'),
    syncTime: z.string().optional().describe("The server's local time of day the albums are synced at, HH:MM"),
    nextSyncAt: z.string().optional().describe('When they are synced next, if every day'),
    syncPending: z.boolean().optional().describe('Whether a sync waits or runs'),
    lastSync: SynologySyncReportSchema.optional().describe('What the last sync did'),
  })
  .meta({ id: 'SynologyAccountResponseDto' });

const SynologySyncScheduleSchema = z
  .object({
    autoSync: z.boolean().describe('Sync the albums every day'),
    syncTime: z
      .string()
      .trim()
      .refine(isSynologySyncTime, 'Must be a time of day such as 03:00')
      .describe("The server's local time of day to sync them at, HH:MM"),
  })
  .meta({ id: 'SynologySyncScheduleDto' });

const SynologyAccountTestResponseSchema = z
  .object({
    success: z.boolean().describe('Whether the server could log in and read Synology Photos'),
    errorReason: SynologyErrorReasonSchema.optional(),
    message: z.string().optional().describe('The error, as Synology or the system reported it'),
    albumCount: z.int().optional().describe('How many albums of its own the account has'),
    account: SynologyAccountResponseSchema,
  })
  .meta({ id: 'SynologyAccountTestResponseDto' });

export class SynologyAccountBindDto extends createZodDto(SynologyAccountBindSchema) {}
export class SynologyAccountResponseDto extends createZodDto(SynologyAccountResponseSchema) {}
export class SynologyAccountTestResponseDto extends createZodDto(SynologyAccountTestResponseSchema) {}
export class SynologySyncScheduleDto extends createZodDto(SynologySyncScheduleSchema) {}
