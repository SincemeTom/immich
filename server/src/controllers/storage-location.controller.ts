import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StorageLocationFolderParamDto,
  StorageLocationUpdateDto,
  StorageLocationsResponseDto,
} from 'src/dtos/storage-location.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { StorageLocationService } from 'src/services/storage-location.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.3.5').alpha('v3.3.5');

@ApiTags(ApiTag.StorageLocations)
@Controller('admin/storage-locations')
export class StorageLocationController {
  constructor(private service: StorageLocationService) {}

  @Get()
  @Authenticated({ permission: Permission.SystemConfigRead, admin: true })
  @Endpoint({
    summary: 'Retrieve storage locations',
    description:
      "Where thumbnails, encoded videos, database backups and each user's originals are kept, whether each can be used now, and how far a move has got.",
    history: history(),
  })
  getStorageLocations(): Promise<StorageLocationsResponseDto> {
    return this.service.getAll();
  }

  @Put('folders/:folder')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    summary: 'Set where a folder is kept',
    description:
      'Keep thumbnails, encoded videos or database backups in a folder on a mounted network share, or in the media location again. The files there now are moved in the background.',
    history: history(),
  })
  updateStorageLocationFolder(
    @Param() { folder }: StorageLocationFolderParamDto,
    @Body() dto: StorageLocationUpdateDto,
  ): Promise<StorageLocationsResponseDto> {
    return this.service.setFolder(folder, dto);
  }

  @Put('users/:id')
  @Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
  @Endpoint({
    summary: "Set where a user's originals are kept",
    description:
      "Keep a user's originals in a folder on a mounted network share, or in the media location again. The storage template migration moves the ones there now.",
    history: history(),
  })
  updateStorageLocationUser(
    @Param() { id }: UUIDParamDto,
    @Body() dto: StorageLocationUpdateDto,
  ): Promise<StorageLocationsResponseDto> {
    return this.service.setUser(id, dto);
  }
}
