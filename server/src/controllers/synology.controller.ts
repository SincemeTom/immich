import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  SynologyAccountBindDto,
  SynologyAccountResponseDto,
  SynologyAccountTestResponseDto,
} from 'src/dtos/synology.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SynologyService } from 'src/services/synology.service.js';

const history = () => new HistoryBuilder().added('v3.3.5').alpha('v3.3.5');

// The user's own settings, so they take the user preference permissions
@ApiTags(ApiTag.Synology)
@Controller('synology/account')
export class SynologyController {
  constructor(private service: SynologyService) {}

  @Get()
  @Authenticated({ permission: Permission.UserPreferenceRead })
  @Endpoint({
    summary: 'Retrieve my Synology account',
    description: 'Retrieve the Synology account the user bound, and what the last login with it found.',
    history: history(),
  })
  getSynologyAccount(@Auth() auth: AuthDto): Promise<SynologyAccountResponseDto> {
    return this.service.getAccount(auth);
  }

  @Put()
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Bind my Synology account',
    description:
      'Log in to Synology with the account, and keep it when that works: the password in the macOS Keychain. Synology may ask for a 2-step verification code, once.',
    history: history(),
  })
  bindSynologyAccount(
    @Auth() auth: AuthDto,
    @Body() dto: SynologyAccountBindDto,
  ): Promise<SynologyAccountTestResponseDto> {
    return this.service.bindAccount(auth, dto);
  }

  @Post('test')
  @Authenticated({ permission: Permission.UserPreferenceRead })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Test my Synology account',
    description: 'Log in to Synology with the bound account, read Synology Photos, and log out.',
    history: history(),
  })
  testSynologyAccount(@Auth() auth: AuthDto): Promise<SynologyAccountTestResponseDto> {
    return this.service.testAccount(auth);
  }

  @Delete()
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Unbind my Synology account',
    description: 'Forget the Synology account, and remove its password from the Keychain.',
    history: history(),
  })
  unbindSynologyAccount(@Auth() auth: AuthDto): Promise<void> {
    return this.service.unbindAccount(auth);
  }
}
