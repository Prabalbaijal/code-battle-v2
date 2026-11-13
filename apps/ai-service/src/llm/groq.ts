import {
  ProviderError,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResult,
  type StreamChunk,
  type Usage,
} from './provider.js';

interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

const toUsage = (u: GroqUsage | undefined): Usage => ({
  inputTokens: u?.prompt_tokens ?? 0,
  outputTokens: u?.completion_tokens ?? 0,
});

/**
 * Groq's OpenAI-compatible chat API over plain fetch (no SDK). The gpt-oss models reason before
 * answering: `reasoning_effort: low` keeps that short (it counts as output tokens) and
 * `include_reasoning: false` keeps it out of the answer.
 */
export class GroqProvider implements ModelProvider {
  readonly name = 'groq';

  constructor(private readonly o: { apiKey: string; baseUrl: string; timeoutMs?: number }) {}

  private body(req: ProviderRequest, stream: boolean) {
    return JSON.stringify({
      model: req.model,
      messages: req.messages,
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.model.startsWith('openai/gpt-oss')
        ? { reasoning_effort: 'low', include_reasoning: false }
        : {}),
      ...(req.json
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: req.json.name, strict: true, schema: req.json.schema },
            },
          }
        : {}),
      ...(stream ? { stream: true } : {}),
    });
  }

  private async post(req: ProviderRequest, stream: boolean): Promise<Response> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 60_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: this.body(req, stream),
        signal,
      });
    } catch (err) {
      throw new ProviderError(`groq unreachable: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retry = Number(res.headers.get('retry-after'));
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // not JSON: keep the text
      }
      throw new ProviderError(
        `groq ${res.status}: ${message}`,
        res.status,
        Number.isFinite(retry) ? retry : undefined,
      );
    }
    return res;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    const res = await this.post(req, false);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: GroqUsage;
    };
    const text = body.choices?.[0]?.message?.content ?? '';
    return { text, usage: toUsage(body.usage) };
  }

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const res = await this.post(req, true);
    if (!res.body) throw new ProviderError('groq: empty stream', 502);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null } }[];
          usage?: GroqUsage;
          x_groq?: { usage?: GroqUsage };
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield { delta };
        const usage = chunk.x_groq?.usage ?? chunk.usage;
        if (usage) yield { usage: toUsage(usage) };
      }
    }
  }
}
