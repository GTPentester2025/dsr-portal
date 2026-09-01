import {
  BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Ip, Param, Post,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DelegationService } from './delegation.service';
import { RateLimitService } from '../public/rate-limit.service';

/** PDFs are not large; this is well above a scanned document and well below
 *  anything that would hurt to hold in memory. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * The three routes the emailed link addresses.
 *
 * Unauthenticated by design: these people have no account. Everything they can
 * do is bounded by the delegation's stage, rate-limited per token, and audited
 * with the source IP.
 */
@Controller('public/delegation')
export class PublicDelegationController {
  constructor(
    private readonly delegation: DelegationService,
    private readonly rate: RateLimitService,
  ) {}

  @Get(':token')
  async view(@Param('token') token: string, @Ip() ip: string) {
    await this.guard(`delegation:view:${ip}`, 120);
    return this.delegation.resolve(token);
  }

  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body() body: { memberId?: string },
    @Ip() ip: string,
  ) {
    await this.guard(`delegation:accept:${ip}`, 20);
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
    await this.guard(`delegation:upload:${ip}`, 40);
    return this.delegation.upload(token, file, ip);
  }

  /** Per IP rather than per token: a leaked link should not become a way to
   *  hammer the service, and the token is the thing being protected. */
  private async guard(key: string, limit: number) {
    const ok = await this.rate.consume(key, limit);
    if (!ok) {
      throw new HttpException('Too many attempts. Try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
