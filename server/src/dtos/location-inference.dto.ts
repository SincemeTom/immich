import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const LocationInferenceClearResponseSchema = z
  .object({
    count: z.int().describe('Number of inferred locations cleared'),
  })
  .meta({ id: 'LocationInferenceClearResponseDto' });

export class LocationInferenceClearResponseDto extends createZodDto(LocationInferenceClearResponseSchema) {}

const LocationInferenceSourceSchema = z
  .object({
    assetId: z
      .uuidv4()
      .nullable()
      .describe('The photo the location was taken from; null when the user cannot see it (not shared with them)'),
    localDateTime: z.string().describe('When that photo was taken, local time'),
    ownerId: z.uuidv4().describe('Whose photo it is'),
    ownerName: z.string().describe('The name of whose photo it is'),
  })
  .meta({ id: 'LocationInferenceSourceDto' });

const LocationInferenceSourceResponseSchema = z
  .object({
    source: LocationInferenceSourceSchema.nullable().describe(
      'What the inferred location was taken from; null when it is not inferred, or that photo is gone',
    ),
  })
  .meta({ id: 'LocationInferenceSourceResponseDto' });

export class LocationInferenceSourceResponseDto extends createZodDto(LocationInferenceSourceResponseSchema) {}
