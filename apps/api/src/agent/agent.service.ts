import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APPROVAL_PENDING_MESSAGE,
  ApprovalDecision,
  ApprovalInterrupt,
  ClinicAgent,
  createClinicAgent,
} from '@clinic/agent';
import { LlmConfig, chatModelName, estimateCostUsd } from '@clinic/llm';
import { Channel, ChatResponse } from '@clinic/shared';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { maskPii } from '../common/mask';
import { Env } from '../config/env';
import { EVENT_BUS, EventBus } from '../events/event-bus';
import { PrismaService } from '../prisma/prisma.module';
import { AgentSessionsService } from './agent-sessions.service';
import { CHAT_MODEL, CHECKPOINTER, LLM_CONFIG } from './agent.providers';
import { ClinicBackendAdapter } from './clinic-backend.adapter';
import { FaqService } from './faq.service';

const FALLBACK_REPLY = 'Sorry, I had trouble with that. Could you say it again?';
const STILL_WAITING_REPLY =
  'Your request is still with the clinic staff for approval. I will update you here as soon as they decide.';

function textOf(message: BaseMessage | undefined): string {
  if (!message) return '';
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => ('text' in part ? String(part.text) : '')).join('');
}

/** Adds up token usage across every model call in one turn, router included. */
class UsageCounter {
  inputTokens = 0;
  outputTokens = 0;

  readonly handler = {
    handleLLMEnd: (output: LLMResult) => {
      for (const generation of output.generations.flat()) {
        const usage = (generation as { message?: AIMessage }).message?.usage_metadata;
        this.inputTokens += usage?.input_tokens ?? 0;
        this.outputTokens += usage?.output_tokens ?? 0;
      }
    },
  };
}

@Injectable()
export class AgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private agent: ClinicAgent;
  private readonly model: string;

  constructor(
    @Inject(CHAT_MODEL) private readonly llm: BaseChatModel,
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
    @Inject(LLM_CONFIG) llmConfig: LlmConfig,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly backend: ClinicBackendAdapter,
    private readonly sessions: AgentSessionsService,
    private readonly faq: FaqService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.model = chatModelName(llmConfig);
  }

  async onModuleInit() {
    await this.checkpointer.setup(); // creates the checkpoint tables on first run
    this.agent = createClinicAgent({
      llm: this.llm,
      backend: this.backend,
      checkpointer: this.checkpointer,
      timezone: this.config.get('CLINIC_TIMEZONE', { infer: true }),
    });

    if (this.config.get('NODE_ENV', { infer: true }) !== 'test') {
      // Not awaited: the API should start even if the embedding provider is down.
      this.faq.index().catch((err) => this.logger.warn(`FAQ indexing skipped: ${err.message}`));
    }
  }

  async onModuleDestroy() {
    await this.checkpointer.end().catch(() => undefined);
  }

  /** One patient message in, one assistant reply out. */
  async chat(threadId: string, sessionId: string, message: string, channel: Channel): Promise<ChatResponse> {
    const started = Date.now();
    await this.sessions.ensure(threadId, channel);

    // While the graph is paused on an interrupt, new input would abandon the
    // pending tool call. Hold the conversation until staff decide.
    const pending = await this.prisma.approvalRequest.findFirst({ where: { threadId, status: 'PENDING' } });
    if (pending) {
      await this.sessions.append(threadId, [
        { role: 'user', content: message },
        { role: 'assistant', content: STILL_WAITING_REPLY },
      ]);
      return this.response(sessionId, STILL_WAITING_REPLY, undefined, true, Date.now() - started, new UsageCounter());
    }

    const usage = new UsageCounter();
    let reply = FALLBACK_REPLY;
    let intent: string | undefined;
    let pendingApproval = false;

    try {
      const result = await this.agent.invoke(
        { messages: [new HumanMessage(message)] },
        { configurable: { thread_id: threadId, channel }, callbacks: [usage.handler], recursionLimit: 25 },
      );
      intent = result.intent;

      const interrupt = await this.pendingInterrupt(threadId);
      if (interrupt) {
        await this.createApproval(threadId, interrupt);
        reply = APPROVAL_PENDING_MESSAGE;
        pendingApproval = true;
      } else {
        reply = textOf(result.messages[result.messages.length - 1]).trim() || FALLBACK_REPLY;
        if (intent === 'faq') await this.sessions.recordOutcome(threadId, 'FAQ_ANSWERED');
      }
    } catch (err) {
      // Never leak a stack trace or provider error to the patient.
      this.logger.error(`Agent run failed for ${threadId}: ${maskPii((err as Error).message)}`);
    }

    const latencyMs = Date.now() - started;
    const response = this.response(sessionId, reply, intent, pendingApproval, latencyMs, usage);
    await this.sessions.append(
      threadId,
      [
        { role: 'user', content: message },
        { role: 'assistant', content: reply },
      ],
      { latencyMs, ...response.usage },
    );
    this.logger.log(
      `chat thread=${threadId} intent=${intent ?? '-'} latency=${latencyMs}ms tokens=${usage.inputTokens}/${usage.outputTokens}`,
    );
    return response;
  }

  /** An admin approved or rejected a paused request: resume the graph where it stopped. */
  async decideApproval(approvalId: string, decision: ApprovalDecision, adminId: string) {
    const approval = await this.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    if (!approval) throw new NotFoundException('Approval request not found');

    // Conditional update, so two admins clicking at once cannot both resume the graph.
    const claimed = await this.prisma.approvalRequest.updateMany({
      where: { id: approvalId, status: 'PENDING' },
      data: { status: decision.approved ? 'APPROVED' : 'REJECTED', decidedBy: adminId, decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new ConflictException('This request has already been decided');

    const started = Date.now();
    const usage = new UsageCounter();
    let reply: string;
    try {
      const result = await this.agent.invoke(new Command({ resume: decision }), {
        configurable: { thread_id: approval.threadId },
        callbacks: [usage.handler],
        recursionLimit: 25,
      });
      reply = textOf(result.messages[result.messages.length - 1]).trim() || FALLBACK_REPLY;
    } catch (err) {
      // Put the request back so the decision is not silently lost.
      await this.prisma.approvalRequest.update({
        where: { id: approvalId },
        data: { status: 'PENDING', decidedBy: null, decidedAt: null },
      });
      this.logger.error(`Resume failed for approval ${approvalId}: ${(err as Error).message}`);
      throw new BadRequestException('Could not resume the conversation. Please try again.');
    }

    const latencyMs = Date.now() - started;
    await this.sessions.append(approval.threadId, [{ role: 'assistant', content: reply }], {
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: estimateCostUsd(this.model, usage.inputTokens, usage.outputTokens),
    });
    await this.events.publish({
      type: 'approval.decided',
      approvalId,
      threadId: approval.threadId,
      approved: decision.approved,
    });
    return { ...(await this.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })), reply };
  }

  listApprovals(status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
    return this.prisma.approvalRequest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  private async pendingInterrupt(threadId: string): Promise<ApprovalInterrupt | undefined> {
    const state = await this.agent.getState({ configurable: { thread_id: threadId } });
    for (const task of state.tasks) {
      const value = task.interrupts?.[0]?.value as ApprovalInterrupt | undefined;
      if (value) return value;
    }
    return undefined;
  }

  private async createApproval(threadId: string, interrupt: ApprovalInterrupt) {
    const booking = await this.prisma.booking.findUnique({ where: { reference: interrupt.bookingId } });
    const approval = await this.prisma.approvalRequest.create({
      data: {
        threadId,
        bookingId: booking?.id,
        type: interrupt.type,
        summary: interrupt.summary,
        payload: { bookingReference: interrupt.bookingId },
      },
    });
    await this.events.publish({ type: 'approval.requested', approvalId: approval.id, threadId });
  }

  private response(
    sessionId: string,
    reply: string,
    intent: string | undefined,
    pendingApproval: boolean,
    latencyMs: number,
    usage: UsageCounter,
  ): ChatResponse {
    return {
      sessionId,
      reply,
      intent,
      pendingApproval,
      latencyMs,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: estimateCostUsd(this.model, usage.inputTokens, usage.outputTokens),
      },
    };
  }
}
