import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { MAX_IMPORT_BYTES, MigrationService } from './migration.service';
import type { DateOrder } from './csv-import';

const ZONES = new Set(['EUR', 'SAZ', 'MAZ']);

/**
 * Bringing case history over from another DSR tool.
 *
 * Two steps on purpose. `analyse` reads the file and proposes what each column
 * means; `commit` writes the cases. Between them the operator can correct the
 * mapping and the date order, which are the two things that corrupt an import
 * silently if they are guessed wrong.
 */
@Controller('internal/migration')
@UseGuards(AuthGuard)
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  /** Zone managers import into their own zone; administrators into any. */
  private assertZone(req: AuthedRequest, zone: string) {
    if (!ZONES.has(zone)) throw new BadRequestException('Unknown zone');
    if (req.user.role === 'zone_manager' && req.user.zoneId !== zone) {
      throw new ForbiddenException('You can only import into your own zone');
    }
  }

  @Get('imports')
  @Requires('config.manage')
  list(@Req() req: AuthedRequest) {
    return this.migration.list(req.zoneCtx);
  }

  @Get('imports/:id')
  @Requires('config.manage')
  detail(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.migration.detail(req.zoneCtx, id);
  }

  @Post('analyse')
  @Requires('config.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES } }))
  analyse(
    @Req() req: AuthedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { zoneId?: string; formKey?: string },
    @Ip() ip: string,
  ) {
    if (!file) throw new BadRequestException('Choose a CSV file to import');
    const zoneId = (body?.zoneId ?? '').trim();
    const formKey = (body?.formKey ?? '').trim();
    if (!formKey) throw new BadRequestException('Choose which form these cases were submitted on');
    this.assertZone(req, zoneId);

    return this.migration.analyse({
      buffer: file.buffer,
      filename: file.originalname,
      zoneId,
      formKey,
      actorId: req.user.id,
      ip,
    });
  }

  /** Re-run the preview against a corrected mapping or date order. */
  @Post('imports/:id/preview')
  @Requires('config.manage')
  preview(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { mapping?: Record<string, string>; dateOrder?: DateOrder },
  ) {
    return this.migration.reanalyse(req.zoneCtx, id, body ?? {});
  }

  @Post('imports/:id/commit')
  @Requires('config.manage')
  commit(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { mapping?: Record<string, string>; dateOrder?: DateOrder },
    @Ip() ip: string,
  ) {
    return this.migration.commit(req.zoneCtx, id, body ?? {}, req.user.id, ip);
  }

  @Delete('imports/:id')
  @Requires('config.manage')
  discard(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.migration.discard(req.zoneCtx, id, req.user.id);
  }
}
