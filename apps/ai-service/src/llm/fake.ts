import type { ModelProvider, ProviderRequest, ProviderResult, StreamChunk } from './provider.js';

export type FakeHandler = (req: ProviderRequest) => string | Promise<string>;

/** Rough token count for accounting in tests (no tokenizer needed). */
const tokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Scripted provider for tests and for `AI_PROVIDER=fake` in development (no key, no quota).
 * Answers by request: JSON requests get a valid object for their schema name.
 */
export class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly calls: ProviderRequest[] = [];

  constructor(private handler: FakeHandler = defaultFake) {}

  /** Tests swap behaviour mid-run (e.g. make the leak guard say "reveals"). */
  setHandler(h: FakeHandler) {
    this.handler = h;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    this.calls.push(req);
    const text = await this.handler(req);
    const input = req.messages.reduce((n, m) => n + tokens(m.content), 0);
    return { text, usage: { inputTokens: input, outputTokens: tokens(text) } };
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const { text, usage } = await this.complete(req);
    for (const word of text.match(/\S+\s*/g) ?? []) yield { delta: word };
    yield { usage };
  }
}

export function defaultFake(req: ProviderRequest): string {
  switch (req.json?.name) {
    case 'match_review':
      return JSON.stringify({
        summary: 'A solid attempt: the idea was right, one detail cost the accepted verdict.',
        verdictExplanation: 'The sums can exceed the int range, so a 32-bit int overflows on large cases.',
        complexity: { time: 'O(n)', space: 'O(1)' },
        issues: [{ title: 'Integer overflow', detail: 'Use long long for values up to 10^12.' }],
        betterApproach: 'Read all pairs with fast input and add them in 64-bit integers.',
        comparison: 'Your opponent used 64-bit integers from the start.',
        tips: ['Check the constraints for the value range first.', 'Prefer long long for sums.'],
      });
    case 'leak_guard':
      return JSON.stringify({ revealsSolution: false, reason: 'A direction, not a solution.' });
    default:
      break;
  }
  const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
  if (system.includes('HINT')) return 'Think about how large the values can get before you choose a type.';
  // the tutor: answer from the first context block and cite it
  return 'Prefix sums let you answer each range query in O(1) after an O(n) pass [1].';
}
