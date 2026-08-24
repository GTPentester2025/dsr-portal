import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { VerificationService } from './verification.service';
import { cookieSecure } from '../auth/auth.controller';
import { IntakeService } from './intake.service';

const SESSION_COOKIE = 'dsr_sid';

function getOrSetSession(req: Request, res: Response): string {
  const existing = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing)) return existing;
  const sid = randomBytes(24).toString('base64url');
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(),
    maxAge: 24 * 3600_000,
  });
  return sid;
}

@Controller('public')
export class PublicController {
  constructor(
    private readonly verification: VerificationService,
    private readonly intake: IntakeService,
  ) {}

  @Post('drafts')
  async createDraft(
    @Body() body: { formKey?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const formKey = body?.formKey;
    if (!formKey || !/^[a-z0-9-]{1,50}$/.test(formKey)) {
      throw new BadRequestException('formKey required');
    }
    const sessionId = getOrSetSession(req, res);
    return this.verification.createDraft(formKey, sessionId);
  }

  @Post('verification/send')
  async sendVerification(
    @Body() body: { draftId?: string; email?: string; captchaToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const sessionId = getOrSetSession(req, res);
    if (!body?.draftId || !body?.email) {
      // still uniform: accepted, padded inside the service on the happy path
      return { status: 'accepted' };
    }
    return this.verification.sendVerification({
      draftId: body.draftId,
      email: body.email,
      sessionId,
      ip,
      captchaToken: body.captchaToken,
    });
  }

  /** Magic-link landing. Always a generic page; replayed/expired identical. */
  @Get('verification/consume')
  async consume(@Query('token') token: string, @Res() res: Response) {
    const ok = await this.verification.consumeToken(token ?? '');
    res
      .status(200)
      .type('html')
      .send(
        ok
          ? '<!doctype html><meta charset="utf-8"><title>Email confirmed</title><p style="font-family:sans-serif">Your email address has been confirmed. You can return to the form tab and submit your request.</p>'
          : '<!doctype html><meta charset="utf-8"><title>Link expired</title><p style="font-family:sans-serif">This link is no longer valid. Please return to the form and request a new verification email.</p>',
      );
  }

  @Get('drafts/:id/status')
  async draftStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sessionId = getOrSetSession(req, res);
    return this.verification.draftStatus(id, sessionId);
  }

  @Post('submissions')
  async submit(
    @Body() body: { draftId?: string; formKey?: string; values?: Record<string, unknown> },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const sessionId = getOrSetSession(req, res);
    if (!body?.draftId || !body?.formKey || !body?.values || typeof body.values !== 'object') {
      throw new BadRequestException('draftId, formKey and values are required');
    }
    return this.intake.submit({
      draftId: body.draftId,
      sessionId,
      formKey: body.formKey,
      values: body.values,
      ip,
    });
  }
}
