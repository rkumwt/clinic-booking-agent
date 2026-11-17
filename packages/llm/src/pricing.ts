// USD per 1 million tokens. These are list prices copied by hand and will go
// stale: check the provider's pricing page before trusting a cost report.
// Local Ollama models cost nothing per token.
const PRICES: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /nova-lite/, input: 0.06, output: 0.24 },
  { match: /nova-micro/, input: 0.035, output: 0.14 },
  { match: /claude-3-5-haiku|claude-haiku/, input: 0.8, output: 4 },
  { match: /gpt-4o-mini/, input: 0.15, output: 0.6 },
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES.find((p) => p.match.test(model));
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
