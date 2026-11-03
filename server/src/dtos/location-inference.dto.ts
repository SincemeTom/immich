import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const LocationInferenceClearResponseSchema = z
  .object({
    count: z.int().describe('Number of inferred locations cleared'),
  })
  .meta({ id: 'LocationInferenceClearResponseDto' });

export class LocationInferenceClearResponseDto extends createZodDto(LocationInferenceClearResponseSchema) {}
