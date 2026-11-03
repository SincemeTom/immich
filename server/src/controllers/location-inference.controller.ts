import { Controller, Delete, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  LocationInferenceClearResponseDto,
  LocationInferenceSourceResponseDto,
} from 'src/dtos/location-inference.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { LocationInferenceService } from 'src/services/location-inference.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.3.5').alpha('v3.3.5');

@ApiTags(ApiTag.Assets)
@Controller('inferred-locations')
export class LocationInferenceController {
  constructor(private service: LocationInferenceService) {}

  @Get(':id')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get what the inferred location of an asset was taken from',
    description: 'The photo, taken around the asset, that location inference took its location from.',
    history: history(),
  })
  getInferredLocationSource(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<LocationInferenceSourceResponseDto> {
    return this.service.getSource(auth, id);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Clear the inferred location of an asset',
    description:
      'Clear the location that location inference gave to the asset. It is not inferred again; a location set by hand still can be.',
    history: history(),
  })
  clearInferredLocation(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.clear(auth, id);
  }
}

@ApiTags(ApiTag.Assets)
@Controller('admin/inferred-locations')
export class LocationInferenceAdminController {
  constructor(private service: LocationInferenceService) {}

  @Delete()
  @Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Clear all inferred locations',
    description:
      'Clear the locations that location inference gave to the assets of all users. With location inference on, they can be inferred again.',
    history: history(),
  })
  clearInferredLocations(): Promise<LocationInferenceClearResponseDto> {
    return this.service.clearAll();
  }
}
