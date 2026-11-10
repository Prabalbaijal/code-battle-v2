import { signInternalToken } from '@cb/auth';
import { judgeSpecSchema, type JudgeSpec } from '@cb/contracts';
import { createHttpClient, UpstreamError, type HttpClient } from '@cb/http-client';
import { validatePack, type FileSpec } from '@cb/judge-core';

/** What the judge needs from problem-service. An interface so tests can supply problems in memory. */
export interface ProblemSource {
  /** undefined = no such problem (or archived). */
  spec(problemId: string): Promise<JudgeSpec | undefined>;
  /** Text of a test input or expected output, by URL from the spec. */
  text(url: string): Promise<string>;
}

/** Simple size-bounded cache (insertion order; oldest out first). */
class BoundedCache<V> {
  private readonly map = new Map<string, { v: V; size: number }>();
  private total = 0;
  constructor(private readonly maxBytes: number) {}
  get(k: string): V | undefined {
    return this.map.get(k)?.v;
  }
  set(k: string, v: V, size: number) {
    if (size > this.maxBytes) return;
    this.map.delete(k);
    this.map.set(k, { v, size });
    this.total += size;
    for (const [key, e] of this.map) {
      if (this.total <= this.maxBytes) break;
      this.map.delete(key);
      this.total -= e.size;
    }
  }
}

/** problem-service over HTTP with a service token. Specs cached briefly, blobs (immutable) longer. */
export class ProblemServiceSource implements ProblemSource {
  private readonly http: HttpClient;
  private readonly specs = new Map<string, { at: number; spec: JudgeSpec }>();
  private readonly blobs = new BoundedCache<string>(64 * 1024 * 1024);
  private token: { value: string; exp: number } | undefined;

  constructor(private readonly o: { baseUrl: string; secret: string; service: string; specTtlMs?: number }) {
    this.http = createHttpClient({
      name: 'problem-service',
      baseUrl: o.baseUrl,
      timeoutMs: 5000,
      retries: 2,
      headers: () => ({}),
    });
  }

  private async auth(): Promise<Record<string, string>> {
    if (!this.token || this.token.exp < Date.now() + 5000) {
      this.token = {
        value: await signInternalToken(this.o.secret, this.o.service, 60),
        exp: Date.now() + 60_000,
      };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  async spec(problemId: string): Promise<JudgeSpec | undefined> {
    const hit = this.specs.get(problemId);
    if (hit && Date.now() - hit.at < (this.o.specTtlMs ?? 30_000)) return hit.spec;
    try {
      const res = await this.http.request({
        path: `/internal/problems/${problemId}/judge-spec`,
        headers: await this.auth(),
        schema: judgeSpecSchema,
      });
      // Only published specs are cached. A draft is read by setters and calibration, and caching
      // it hid a fresh publish from players for the TTL (found with real Judge0). A published spec
      // can't go stale in a harmful way: changing tests or limits unpublishes the problem.
      if (res.data.status === 'published') this.specs.set(problemId, { at: Date.now(), spec: res.data });
      else this.specs.delete(problemId);
      return res.data;
    } catch (err) {
      if (err instanceof UpstreamError && err.upstreamStatus === 404) return undefined;
      throw err;
    }
  }

  async text(url: string): Promise<string> {
    const hit = this.blobs.get(url);
    if (hit !== undefined) return hit;
    const res = await fetch(url, { headers: await this.auth(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`blob ${url} → ${res.status}`);
    const body = await res.text();
    this.blobs.set(url, body, body.length);
    return body;
  }
}

/** Expected per-case answers of a file (parsed with judge-core; cached by output URL). */
const expectedCache = new BoundedCache<FileSpec['expected']>(64 * 1024 * 1024);

export async function loadFileSpec(src: ProblemSource, file: JudgeSpec['files'][number]): Promise<FileSpec> {
  let expected = expectedCache.get(file.outputUrl);
  if (!expected) {
    const [input, output] = await Promise.all([src.text(file.inputUrl), src.text(file.outputUrl)]);
    const v = validatePack(input, output, file.outputCaseLineCounts);
    if (!v.ok) throw new Error(`stored pack ${file.ordinal} is invalid: ${v.problems[0]!.code}`);
    expected = v.pack.expected;
    expectedCache.set(file.outputUrl, expected, output.length);
  }
  return { ordinal: file.ordinal, kind: file.kind, expected, lineCounts: file.outputCaseLineCounts };
}
