import { BedrockEmbeddings, ChatBedrockConverse } from '@langchain/aws';
import type { Embeddings } from '@langchain/core/embeddings';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { EMBEDDING_DIMENSIONS, LlmConfig } from './config';

// The provider interface is LangChain's own BaseChatModel / Embeddings. The
// agent only ever sees those two types, so switching provider is one env var.
// AWS credentials for Bedrock come from the default credential chain
// (env vars locally, the task role on ECS).

export function createChatModel(config: LlmConfig): BaseChatModel {
  switch (config.LLM_PROVIDER) {
    case 'ollama':
      return new ChatOllama({
        baseUrl: config.OLLAMA_BASE_URL,
        model: config.OLLAMA_CHAT_MODEL,
        temperature: config.LLM_TEMPERATURE,
        numCtx: config.OLLAMA_NUM_CTX,
        // Keep the model in memory between turns instead of reloading it.
        keepAlive: '30m',
      });
    case 'bedrock':
      return new ChatBedrockConverse({
        region: config.AWS_REGION,
        model: config.BEDROCK_CHAT_MODEL,
        temperature: config.LLM_TEMPERATURE,
        maxTokens: 1024,
      });
    case 'openai':
      return new ChatOpenAI({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_CHAT_MODEL,
        temperature: config.LLM_TEMPERATURE,
      });
  }
}

export function createEmbeddings(config: LlmConfig): Embeddings {
  switch (config.LLM_PROVIDER) {
    case 'ollama':
      // mxbai-embed-large is natively 1024-dimensional.
      return new OllamaEmbeddings({ baseUrl: config.OLLAMA_BASE_URL, model: config.OLLAMA_EMBEDDING_MODEL });
    case 'bedrock':
      return new BedrockEmbeddings({
        region: config.AWS_REGION,
        model: config.BEDROCK_EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
      });
    case 'openai':
      return new OpenAIEmbeddings({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
      });
  }
}
