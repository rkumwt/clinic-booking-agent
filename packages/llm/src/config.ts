import { z } from 'zod';

// Every provider must produce vectors of this size: it is the width of the
// faq_documents.embedding column. Switching provider therefore only needs a
// re-embed (POST /faq/reindex), never a migration.
export const EMBEDDING_DIMENSIONS = 1024;

export const LlmConfigSchema = z.object({
  LLM_PROVIDER: z.enum(['ollama', 'bedrock', 'openai']).default('ollama'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),

  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  OLLAMA_CHAT_MODEL: z.string().default('qwen2.5:3b'),
  // Ollama's default context (4096) is too small for a system prompt plus tool schemas.
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(8192),
  OLLAMA_EMBEDDING_MODEL: z.string().default('mxbai-embed-large'),

  AWS_REGION: z.string().default('us-east-1'),
  BEDROCK_CHAT_MODEL: z.string().default('us.amazon.nova-lite-v1:0'),
  BEDROCK_EMBEDDING_MODEL: z.string().default('amazon.titan-embed-text-v2:0'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/** Reads provider settings from environment variables. Empty strings count as unset. */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  return LlmConfigSchema.parse(cleaned);
}

export function chatModelName(config: LlmConfig): string {
  switch (config.LLM_PROVIDER) {
    case 'ollama':
      return config.OLLAMA_CHAT_MODEL;
    case 'bedrock':
      return config.BEDROCK_CHAT_MODEL;
    case 'openai':
      return config.OPENAI_CHAT_MODEL;
  }
}
