import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  NetworkShareCreateDto,
  NetworkShareResponseDto,
  NetworkShareTestDto,
  NetworkShareTestResponseDto,
  NetworkShareUpdateDto,
} from 'src/dtos/network-share.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { NetworkShareService } from 'src/services/network-share.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.3.5').alpha('v3.3.5');

// Network shares exist for external libraries, so they take the library permissions
@ApiTags(ApiTag.NetworkShares)
@Controller('admin/network-shares')
export class NetworkShareController {
  constructor(private service: NetworkShareService) {}

  @Get()
  @Authenticated({ permission: Permission.LibraryRead, admin: true })
  @Endpoint({
    summary: 'Retrieve network shares',
    description: 'Retrieve the network shares the server mounts, with whether each is mounted and how full it is.',
    history: history(),
  })
  getNetworkShares(): Promise<NetworkShareResponseDto[]> {
    return this.service.getAll();
  }

  @Post()
  @Authenticated({ permission: Permission.LibraryCreate, admin: true })
  @Endpoint({
    summary: 'Add a network share',
    description: 'Mount a network share, and keep it mounted. It is only added if it mounts.',
    history: history(),
  })
  createNetworkShare(@Body() dto: NetworkShareCreateDto): Promise<NetworkShareResponseDto> {
    return this.service.create(dto);
  }

  @Post('test')
  @Authenticated({ permission: Permission.LibraryCreate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Test a network share',
    description: 'Mount a network share on a folder of its own, list its top level, and unmount it.',
    history: history(),
  })
  testNetworkShare(@Body() dto: NetworkShareTestDto): Promise<NetworkShareTestResponseDto> {
    return this.service.test(dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.LibraryRead, admin: true })
  @Endpoint({ summary: 'Retrieve a network share', description: 'Retrieve a network share.', history: history() })
  getNetworkShare(@Param() { id }: UUIDParamDto): Promise<NetworkShareResponseDto> {
    return this.service.get(id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @Endpoint({
    summary: 'Update a network share',
    description: 'Rename a network share, or change how it is mounted, which mounts it again.',
    history: history(),
  })
  updateNetworkShare(
    @Param() { id }: UUIDParamDto,
    @Body() dto: NetworkShareUpdateDto,
  ): Promise<NetworkShareResponseDto> {
    return this.service.update(id, dto);
  }

  @Post(':id/mount')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Mount a network share',
    description: 'Mount a network share now, and keep it mounted.',
    history: history(),
  })
  mountNetworkShare(@Param() { id }: UUIDParamDto): Promise<NetworkShareResponseDto> {
    return this.service.mountShare(id);
  }

  @Post(':id/unmount')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Unmount a network share',
    description: 'Unmount a network share, and leave it unmounted until it is mounted again.',
    history: history(),
  })
  unmountNetworkShare(@Param() { id }: UUIDParamDto): Promise<NetworkShareResponseDto> {
    return this.service.unmountShare(id);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.LibraryDelete, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a network share',
    description: 'Unmount a network share and remove it. Refused while an external library imports from it.',
    history: history(),
  })
  deleteNetworkShare(@Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(id);
  }
}
