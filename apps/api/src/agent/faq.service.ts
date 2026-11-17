import { Inject, Injectable, Logger } from '@nestjs/common';
import { FaqHit } from '@clinic/agent';
import { EMBEDDING_DIMENSIONS } from '@clinic/llm';
import type { Embeddings } from '@langchain/core/embeddings';
import { PrismaService } from '../prisma/prisma.module';
import { EMBEDDINGS } from './agent.providers';

// Prisma has no vector type, so everything touching the embedding column is raw SQL.
const toVector = (values: number[]) => `[${values.join(',')}]`;

@Injectable()
export class FaqService {
  private readonly logger = new Logger(FaqService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDINGS) private readonly embeddings: Embeddings,
  ) {}

  /** Embeds FAQ rows that have no vector yet. Pass `all` after changing embedding model. */
  async index(options: { all?: boolean } = {}): Promise<number> {
    const rows = options.all
      ? await this.prisma.$queryRaw<Row[]>`SELECT id, title, content FROM faq_documents`
      : await this.prisma.$queryRaw<Row[]>`SELECT id, title, content FROM faq_documents WHERE embedding IS NULL`;
    if (rows.length === 0) return 0;

    const vectors = await this.embeddings.embedDocuments(rows.map((r) => `${r.title}\n${r.content}`));
    if (vectors[0]?.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding model returned ${vectors[0]?.length} dimensions; the database column needs ${EMBEDDING_DIMENSIONS}`,
      );
    }
    for (const [i, row] of rows.entries()) {
      await this.prisma.$executeRaw`UPDATE faq_documents SET embedding = ${toVector(vectors[i])}::vector WHERE id = ${row.id}`;
    }
    this.logger.log(`Embedded ${rows.length} FAQ document(s)`);
    return rows.length;
  }

  /** Top-k FAQ entries by cosine similarity. `<=>` is pgvector's cosine distance. */
  async search(query: string, k = 3): Promise<FaqHit[]> {
    if (!query.trim()) return [];
    const vector = toVector(await this.embeddings.embedQuery(query));
    return this.prisma.$queryRaw<FaqHit[]>`
      SELECT title, content, (1 - (embedding <=> ${vector}::vector))::float8 AS score
      FROM faq_documents
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${k}`;
  }
}

interface Row {
  id: string;
  title: string;
  content: string;
}
