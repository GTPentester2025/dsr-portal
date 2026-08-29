import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Requires, type AuthedRequest } from '../auth/auth.guard';
import { SystemTemplateService } from './system-template.service';

/**
 * The messages the portal sends on its own behalf.
 *
 * Separate from the Settings controller because these are content, not
 * credentials: an administrator should be able to reword an acknowledgement
 * without holding the keys to the mail provider.
 */
@Controller('internal/admin/system-templates')
@UseGuards(AuthGuard)
@Requires('system.operate')
export class SystemTemplateController {
  constructor(private readonly templates: SystemTemplateService) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Put(':key')
  save(
    @Req() req: AuthedRequest,
    @Param('key') key: string,
    @Body() body: { subject: string; html: string },
  ) {
    return this.templates.save(req.zoneCtx, key, body?.subject ?? '', body?.html ?? '', req.user.id);
  }

  @Delete(':key')
  reset(@Req() req: AuthedRequest, @Param('key') key: string) {
    return this.templates.reset(req.zoneCtx, key, req.user.id);
  }

  /** Fill placeholders with sample values so an edit can be checked safely. */
  @Post(':key/preview')
  preview(@Param('key') key: string, @Body() body: { subject: string; html: string }) {
    return this.templates.preview(key, body?.subject ?? '', body?.html ?? '');
  }
}
