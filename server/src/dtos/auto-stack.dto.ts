import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const AutoStackRunSchema = z
  .object({
    force: z.boolean().optional().describe('Also stack again the assets taken out of a stack that auto stacking made'),
  })
  .meta({ id: 'AutoStackRunDto' });

const AutoStackRemoveResponseSchema = z
  .object({
    count: z.int().describe('Number of stacks removed'),
  })
  .meta({ id: 'AutoStackRemoveResponseDto' });

export class AutoStackRunDto extends createZodDto(AutoStackRunSchema) {}
export class AutoStackRemoveResponseDto extends createZodDto(AutoStackRemoveResponseSchema) {}
