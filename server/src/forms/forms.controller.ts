import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { FIELD_TYPES, FormsService, LAYOUT_TYPES, type FormSchemaDoc } from './forms.service';

/** Field palette shown by the builder, kept beside the renderer's capabilities. */
const PALETTE = [
  { type: 'dsrtextfield', label: 'Short text', icon: 'edit', description: 'Single line of text' },
  { type: 'textarea', label: 'Long text', icon: 'file', description: 'Multi-line answer' },
  { type: 'dsremail', label: 'Email address', icon: 'mail', description: 'Validated email input' },
  { type: 'dsrphoneNumber', label: 'Phone number', icon: 'inbox', description: 'Telephone input' },
  { type: 'dsrselect', label: 'Dropdown', icon: 'chevronDown', description: 'Pick one from a list' },
  { type: 'dsrselectboxes', label: 'Checkboxes', icon: 'checkCircle', description: 'Pick several options' },
  { type: 'dsrradio', label: 'Radio buttons', icon: 'checkCircle', description: 'Pick exactly one' },
  { type: 'checkbox', label: 'Single checkbox', icon: 'check', description: 'Consent or confirmation' },
  { type: 'dsrdatetime', label: 'Date', icon: 'clock', description: 'Date picker' },
  { type: 'file', label: 'File upload', icon: 'download', description: 'Identity documents and evidence' },
  { type: 'htmlelement', label: 'Text block', icon: 'file', description: 'Explanatory copy, not an input' },
];

@Controller('internal/forms')
@UseGuards(AuthGuard)
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  /** Zone managers may only touch forms belonging to their own zone. */
  private assertZone(req: AuthedRequest, zone: string) {
    if (req.user.role === 'zone_manager' && req.user.zoneId !== zone) {
      throw new ForbiddenException('You can only edit forms in your own zone');
    }
  }

  @Get('palette')
  @Requires('config.manage')
  palette() {
    return { palette: PALETTE, fieldTypes: FIELD_TYPES, layoutTypes: LAYOUT_TYPES };
  }

  @Get()
  @Requires('config.manage')
  async list(@Req() req: AuthedRequest) {
    const all = await this.forms.list();
    return req.user.role === 'zone_manager'
      ? all.filter((f) => f.zone === req.user.zoneId)
      : all;
  }

  @Get(':key')
  @Requires('config.manage')
  async get(@Req() req: AuthedRequest, @Param('key') key: string) {
    const result = await this.forms.get(key);
    this.assertZone(req, result.schema.zone);
    return result;
  }

  @Get(':key/history')
  @Requires('config.manage')
  async history(@Req() req: AuthedRequest, @Param('key') key: string) {
    const { schema } = await this.forms.get(key);
    this.assertZone(req, schema.zone);
    return this.forms.history(key);
  }

  @Put(':key')
  @Requires('config.manage')
  async publish(
    @Req() req: AuthedRequest,
    @Param('key') key: string,
    @Body() body: Partial<FormSchemaDoc>,
    @Ip() ip: string,
  ) {
    const current = await this.forms.get(key);
    this.assertZone(req, current.schema.zone);
    if (!body || typeof body !== 'object') throw new BadRequestException('A schema body is required');
    return this.forms.publish(key, body, req.user.id, ip);
  }

  @Post(':key/restore/:version')
  @Requires('config.manage')
  async restore(
    @Req() req: AuthedRequest,
    @Param('key') key: string,
    @Param('version') version: string,
    @Ip() ip: string,
  ) {
    const current = await this.forms.get(key);
    this.assertZone(req, current.schema.zone);
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1) throw new BadRequestException('bad version');
    return this.forms.restore(key, n, req.user.id, ip);
  }
}

/**
 * Public schema delivery. Serving from the database (rather than static files)
 * is what makes an edit in the builder appear on the live form immediately.
 */
@Controller('public/forms')
export class PublicFormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  async manifest() {
    const forms = await this.forms.list();
    const zones: Record<
      string,
      { key: string; name: string; country: string | null; languages: string[]; fieldCount: number }[]
    > = {};
    for (const f of forms) {
      (zones[f.zone] ??= []).push({
        key: f.key,
        name: f.name,
        country: f.country,
        languages: f.languages,
        fieldCount: f.fieldCount,
      });
    }
    return { zones };
  }

  @Get(':key')
  async get(@Param('key') key: string) {
    const { schema, version } = await this.forms.get(key);
    // The public bundle never needs operational settings.
    const { settings: _settings, rules: _rules, ...safe } = schema as Record<string, unknown>;
    return { ...safe, version };
  }
}
