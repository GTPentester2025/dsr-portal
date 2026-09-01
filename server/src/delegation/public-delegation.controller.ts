import {
  BadRequestException, Body, Controller, Get, Ip, Param, Post,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DelegationService } from './delegation.service';
import { DelegationRateGuard } from './delegation-rate.guard';

/** PDFs are not large; this is well above a scanned document and well below
 *  anything that would hurt to hold in memory. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * The three routes the emailed link addresses.
 *
 * Unauthenticated by design: these people have no account. Everything they can
 * do is bounded by the delegation's stage, rate-limited per token (and, more
 * loosely, per IP), and audited with the source IP.
 *
 * `DelegationRateGuard` is applied at the controller so it runs as a guard —
 * ahead of `FileInterceptor` on the upload route. A limiter consumed inside a
 * handler body would run after the interceptor had already buffered the
 * whole multipart upload into memory, which defeats the point of limiting it.
 */
@Controller('public/delegation')
@UseGuards(DelegationRateGuard)
export class PublicDelegationController {
  constructor(private readonly delegation: DelegationService) {}

  @Get(':token')
  async view(@Param('token') token: string, @Ip() ip: string) {
    return this.delegation.resolve(token, ip);
  }

  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body() body: { memberId?: string },
    @Ip() ip: string,
  ) {
    if (!body?.memberId) throw new BadRequestException('Choose who you are');
    return this.delegation.accept(token, body.memberId, ip);
  }

  @Post(':token/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES } }))
  async upload(
    @Param('token') token: string,
    @UploadedFile() file: Express.Multer.File,
    @Ip() ip: string,
  ) {
    return this.delegation.upload(token, file, ip);
  }
}
