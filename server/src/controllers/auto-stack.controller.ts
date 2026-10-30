import { Body, Controller, Delete, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AutoStackRemoveResponseDto, AutoStackRunDto } from 'src/dtos/auto-stack.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AutoStackService } from 'src/services/auto-stack.service.js';

const history = () => new HistoryBuilder().added('v3.3.5').alpha('v3.3.5');

@ApiTags(ApiTag.Stacks)
@Controller('auto-stacks')
export class AutoStackController {
  constructor(private service: AutoStackService) {}

  @Post('run')
  @Authenticated({ permission: Permission.StackCreate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Stack my assets automatically',
    description:
      'Stack the assets of the user, as their auto stacking preferences say, in the background. Assets taken out of a stack that auto stacking made are left alone, unless `force` is set.',
    history: history(),
  })
  runAutoStack(@Auth() auth: AuthDto, @Body() dto: AutoStackRunDto): Promise<void> {
    return this.service.run(auth, dto.force);
  }

  @Delete()
  @Authenticated({ permission: Permission.StackDelete })
  @Endpoint({
    summary: 'Remove automatic stacks',
    description: 'Remove the stacks auto stacking made for the user. Their assets are kept.',
    history: history(),
  })
  removeAutoStacks(@Auth() auth: AuthDto): Promise<AutoStackRemoveResponseDto> {
    return this.service.removeAll(auth);
  }
}
