import { Controller, Get, Ip, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { SchemaService } from './schema.service';

/**
 * The database schema, as an operator sees it.
 *
 * Deliberately two routes rather than one: knowing whether the schema is
 * behind the code is useful on its own and safe for anyone holding the
 * permission to ask, while applying migrations is the sharpest action the
 * console offers. Reading does not imply doing.
 */
@Controller('internal/admin/schema')
@UseGuards(AuthGuard)
export class SchemaController {
  constructor(private readonly schema: SchemaService) {}

  @Get()
  @Requires('schema.migrate')
  status() {
    return this.schema.status();
  }

  @Post('migrate')
  @Requires('schema.migrate')
  migrate(@Req() req: AuthedRequest, @Ip() ip: string) {
    return this.schema.migrate(req.user.id, ip);
  }
}
