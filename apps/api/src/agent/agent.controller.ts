import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApprovalDecisionInput,
  ApprovalDecisionSchema,
  AuthUser,
  ChatRequest,
  ChatRequestSchema,
} from '@clinic/shared';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AgentSessionsService } from './agent-sessions.service';
import { AgentService } from './agent.service';
import { FaqService } from './faq.service';

const ApprovalQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() });

// The thread id includes the caller's id, so one user can never read or
// continue another user's conversation by guessing a session id.
const threadIdFor = (user: AuthUser, sessionId: string) => `${user.id}__${sessionId}`;

@Controller()
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly sessions: AgentSessionsService,
    private readonly faq: FaqService,
  ) {}

  @Post('chat')
  @HttpCode(200)
  chat(@Body(new ZodValidationPipe(ChatRequestSchema)) body: ChatRequest, @CurrentUser() user: AuthUser) {
    const sessionId = body.sessionId ?? randomUUID();
    return this.agent.chat(threadIdFor(user, sessionId), sessionId, body.message, body.channel);
  }

  /** The conversation so far. The chat app polls this to pick up a staff decision. */
  @Get('chat/:sessionId')
  transcript(@Param('sessionId', ParseUUIDPipe) sessionId: string, @CurrentUser() user: AuthUser) {
    return this.sessions.transcript(threadIdFor(user, sessionId));
  }

  @Roles('ADMIN')
  @Get('approvals')
  approvals(@Query(new ZodValidationPipe(ApprovalQuery)) query: z.infer<typeof ApprovalQuery>) {
    return this.agent.listApprovals(query.status);
  }

  @Roles('ADMIN')
  @Post('approvals/:id/decision')
  @HttpCode(200)
  decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApprovalDecisionSchema)) body: ApprovalDecisionInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.agent.decideApproval(id, body, user.id);
  }

  /** Re-embeds every FAQ. Run after changing the embedding provider or model. */
  @Roles('ADMIN')
  @Post('faq/reindex')
  @HttpCode(200)
  async reindex() {
    return { embedded: await this.faq.index({ all: true }) };
  }
}
