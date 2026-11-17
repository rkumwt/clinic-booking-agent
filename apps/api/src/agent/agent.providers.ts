import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmConfig, createChatModel, createEmbeddings, loadLlmConfig } from '@clinic/llm';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Env } from '../config/env';

export const LLM_CONFIG = Symbol('LLM_CONFIG');
export const CHAT_MODEL = Symbol('CHAT_MODEL');
export const EMBEDDINGS = Symbol('EMBEDDINGS');
export const CHECKPOINTER = Symbol('CHECKPOINTER');

// LangGraph keeps its checkpoint tables in their own Postgres schema so that
// Prisma Migrate (which owns `public`) never sees them as drift.
export const CHECKPOINT_SCHEMA = 'langgraph';

export const agentProviders: Provider[] = [
  // ConfigModule has already copied .env into process.env by the time this runs.
  { provide: LLM_CONFIG, useFactory: (): LlmConfig => loadLlmConfig(process.env) },
  { provide: CHAT_MODEL, inject: [LLM_CONFIG], useFactory: (config: LlmConfig) => createChatModel(config) },
  { provide: EMBEDDINGS, inject: [LLM_CONFIG], useFactory: (config: LlmConfig) => createEmbeddings(config) },
  {
    provide: CHECKPOINTER,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>) => {
      // `?schema=public` is a Prisma-only parameter that node-postgres does not understand.
      const url = new URL(config.get('DATABASE_URL', { infer: true }));
      url.searchParams.delete('schema');
      return PostgresSaver.fromConnString(url.toString(), { schema: CHECKPOINT_SCHEMA });
    },
  },
];
