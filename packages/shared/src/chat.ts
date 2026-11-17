import { z } from 'zod';
import { Channel } from './enums';

export const ChatRequestSchema = z.object({
  // The client generates this once per conversation and sends it with every message.
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  channel: Channel.default('CHAT'),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface ChatResponse {
  sessionId: string;
  reply: string;
  intent?: string;
  /** True while the conversation is paused waiting for clinic staff. */
  pendingApproval: boolean;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export const ApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  note: z.string().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionSchema>;
