import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { SynologyErrorReason, toSynologyUrl } from 'src/utils/synology.js';

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
  })
  .meta({ id: 'SynologyAccountResponseDto' });

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
