import {
  Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { GroupsService, type GroupMemberInput } from './groups.service';
import { DelegationService } from './delegation.service';

/**
 * Groups and delegations from inside the portal.
 *
 * All of it is `cases.work`: sending a case to HR is case work, and so is
 * keeping the list of who in HR to send it to. Putting group management behind
 * `config.manage` would mean an approver could send to a group but not add the
 * colleague they actually need, which is the wrong seam.
 */
@Controller('internal')
@UseGuards(AuthGuard)
export class DelegationController {
  constructor(
    private readonly groups: GroupsService,
    private readonly delegation: DelegationService,
  ) {}

  @Get('groups')
  @Requires('cases.work')
  listGroups(@Req() req: AuthedRequest) {
    return this.groups.list(req.zoneCtx);
  }

  @Post('groups')
  @Requires('cases.work')
  createGroup(
    @Req() req: AuthedRequest,
    @Body() body: { zoneId?: string; name?: string; defaultMessage?: string; members?: GroupMemberInput[] },
  ) {
    // A zone manager or approver gets their own zone whatever they ask for.
    const zoneId =
      req.user.role === 'admin' || req.user.role === 'super_admin'
        ? (body?.zoneId ?? req.user.zoneId ?? '')
        : (req.user.zoneId ?? '');
    return this.groups.create(req.zoneCtx, {
      zoneId,
      name: body?.name ?? '',
      defaultMessage: body?.defaultMessage,
      members: body?.members ?? [],
      actorId: req.user.id,
    });
  }

  @Patch('groups/:id')
  @Requires('cases.work')
  updateGroup(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; defaultMessage?: string; active?: boolean; members?: GroupMemberInput[] },
  ) {
    return this.groups.update(req.zoneCtx, id, body ?? {}, req.user.id);
  }

  @Post('cases/:id/delegate')
  @Requires('cases.work')
  delegate(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { groupId?: string; note?: string },
    @Ip() ip: string,
  ) {
    return this.delegation.send(req.zoneCtx, {
      caseId: id,
      groupId: body?.groupId ?? '',
      note: body?.note ?? '',
      actorId: req.user.id,
      ip,
    });
  }

  @Post('cases/:id/delegations/:did/close')
  @Requires('cases.work')
  closeDelegation(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('did', ParseUUIDPipe) did: string,
  ) {
    return this.delegation.close(req.zoneCtx, id, did, req.user.id);
  }
}
