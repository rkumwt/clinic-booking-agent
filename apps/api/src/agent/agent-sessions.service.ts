import { Injectable } from '@nestjs/common';
import { Channel, TranscriptEntry } from '@clinic/shared';
import { Prisma, SessionOutcome } from '@prisma/client';
import { maskPii } from '../common/mask';
import { PrismaService } from '../prisma/prisma.module';

export interface TurnMetrics {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** One row per conversation: transcript, running totals and how it ended. */
@Injectable()
export class AgentSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  ensure(threadId: string, channel: Channel) {
    return this.prisma.agentSession.upsert({ where: { threadId }, create: { threadId, channel }, update: {} });
  }

  async transcript(threadId: string): Promise<TranscriptEntry[]> {
    const session = await this.prisma.agentSession.findUnique({ where: { threadId } });
    return (session?.transcript as unknown as TranscriptEntry[] | undefined) ?? [];
  }

  /** Appends messages (with phone numbers and emails masked) and adds to the running totals. */
  async append(threadId: string, entries: Array<Omit<TranscriptEntry, 'at'>>, metrics?: TurnMetrics) {
    const at = new Date().toISOString();
    const masked = entries.map((e) => ({ role: e.role, content: maskPii(e.content), at }));
    // Appending inside Postgres avoids losing a message when two writes overlap.
    await this.prisma.$executeRaw`
      UPDATE agent_sessions SET
        transcript = transcript || ${JSON.stringify(masked)}::jsonb,
        latency_ms = latency_ms + ${metrics?.latencyMs ?? 0},
        input_tokens = input_tokens + ${metrics?.inputTokens ?? 0},
        output_tokens = output_tokens + ${metrics?.outputTokens ?? 0},
        cost_usd = cost_usd + ${new Prisma.Decimal(metrics?.costUsd ?? 0)},
        updated_at = now()
      WHERE thread_id = ${threadId}`;
  }

  /**
   * Records how a conversation went. A weak outcome (FAQ answered) never
   * overwrites a strong one (booked, cancelled, handed off).
   */
  async recordOutcome(threadId: string, outcome: SessionOutcome, patientId?: string) {
    const weak = outcome === 'FAQ_ANSWERED';
    await this.prisma.agentSession.updateMany({
      where: { threadId, ...(weak ? { outcome: 'IN_PROGRESS' } : {}) },
      data: { outcome, ...(patientId ? { patientId } : {}) },
    });
  }
}
