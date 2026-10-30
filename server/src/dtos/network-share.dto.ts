import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  NetworkShareErrorReason,
  NetworkShareProtocol,
  NetworkShareStatus,
  NfsVersion,
  isValidHost,
} from 'src/utils/network-share.js';

const NetworkShareProtocolSchema = z
  .enum(NetworkShareProtocol)
  .describe('Network share protocol')
  .meta({ id: 'NetworkShareProtocol' });
const NfsVersionSchema = z.enum(NfsVersion).describe('NFS version, or auto').meta({ id: 'NfsVersion' });
const NetworkShareStatusSchema = z
  .enum(NetworkShareStatus)
  .describe('Network share status')
  .meta({ id: 'NetworkShareStatus' });
const NetworkShareErrorReasonSchema = z
  .enum(NetworkShareErrorReason)
  .describe('Why mounting or reading a network share failed')
  .meta({ id: 'NetworkShareErrorReason' });

const host = z
  .string()
  .trim()
  .refine((value) => isValidHost(value), 'Must be a host name or an IP address')
  .describe('Server host name or IP address');
const exportPath = z
  .string()
  .trim()
  .regex(/^\/[^\0]*$/, 'Must be an absolute path, such as /volume1/photo')
  .max(1024)
  .describe('Exported path on the server, such as /volume1/photo');

const NetworkShareConnectionSchema = z.object({
  protocol: NetworkShareProtocolSchema.default(NetworkShareProtocol.Nfs),
  host,
  exportPath,
  nfsVersion: NfsVersionSchema.default(NfsVersion.Auto),
  readOnly: z.boolean().default(false).describe('Mount read-only'),
});

const NetworkShareTestSchema = NetworkShareConnectionSchema.meta({ id: 'NetworkShareTestDto' });

const NetworkShareCreateSchema = NetworkShareConnectionSchema.extend({
  name: z.string().trim().min(1).max(64).describe('Share name'),
}).meta({ id: 'NetworkShareCreateDto' });

const NetworkShareUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional().describe('Share name'),
    host: host.optional(),
    exportPath: exportPath.optional(),
    nfsVersion: NfsVersionSchema.optional(),
    readOnly: z.boolean().optional().describe('Mount read-only'),
  })
  .meta({ id: 'NetworkShareUpdateDto' });

const NetworkShareResponseSchema = z
  .object({
    id: z.uuidv4().describe('Share ID'),
    name: z.string().describe('Share name'),
    protocol: NetworkShareProtocolSchema,
    host: z.string().describe('Server host name or IP address'),
    exportPath: z.string().describe('Exported path on the server'),
    nfsVersion: NfsVersionSchema,
    readOnly: z.boolean().describe('Mounted read-only'),
    enabled: z.boolean().describe('Kept mounted: reconnected when it drops'),
    mountPath: z.string().describe('Where it is mounted on this Mac, the path external libraries import from'),
    status: NetworkShareStatusSchema,
    errorReason: NetworkShareErrorReasonSchema.optional(),
    message: z.string().optional().describe('The last error, as the system reported it'),
    totalBytes: z.int().optional().describe('Size of the share, when mounted'),
    availableBytes: z.int().optional().describe('Free space on the share, when mounted'),
    libraries: z.array(z.string()).describe('Names of the external libraries that import from it'),
  })
  .meta({ id: 'NetworkShareResponseDto' });

const NetworkShareTestResponseSchema = z
  .object({
    success: z.boolean().describe('Whether the share could be mounted and read'),
    errorReason: NetworkShareErrorReasonSchema.optional(),
    message: z.string().optional().describe('The error, as the system reported it'),
    entries: z.array(z.string()).describe('Some of the files and folders at its top level'),
  })
  .meta({ id: 'NetworkShareTestResponseDto' });

export class NetworkShareTestDto extends createZodDto(NetworkShareTestSchema) {}
export class NetworkShareCreateDto extends createZodDto(NetworkShareCreateSchema) {}
export class NetworkShareUpdateDto extends createZodDto(NetworkShareUpdateSchema) {}
export class NetworkShareResponseDto extends createZodDto(NetworkShareResponseSchema) {}
export class NetworkShareTestResponseDto extends createZodDto(NetworkShareTestResponseSchema) {}
