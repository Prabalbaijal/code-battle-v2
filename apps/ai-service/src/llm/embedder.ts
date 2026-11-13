import type { Logger } from '@cb/logger';
import { createHash } from 'node:crypto';
import { EMBEDDING_DIM } from '../db/schema.js';

/** Text → vector for the tutor's retrieval (plan §22.1: embeddings are free, computed locally). */
export interface Embedder {
  readonly name: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** bge models want this prefix on queries (not on documents). */
const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';

type Extractor = (
  texts: string[],
  opts: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * A small sentence-embedding model run on the CPU with transformers.js (ONNX). Downloaded once
 * (~30 MB, quantized) into the model cache, then fully offline. Loaded lazily on first use.
 */
export class LocalEmbedder implements Embedder {
  readonly name: string;
  private extractor: Promise<Extractor> | undefined;

  constructor(private readonly o: { model: string; cacheDir?: string | undefined; logger: Logger }) {
    this.name = o.model;
  }

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const t = await import('@huggingface/transformers');
      if (this.o.cacheDir) t.env.cacheDir = this.o.cacheDir;
      const started = Date.now();
      const pipe = (await t.pipeline('feature-extraction', this.o.model, {
        dtype: 'q8',
      })) as unknown as Extractor;
      this.o.logger.info({ model: this.o.model, ms: Date.now() - started }, 'embedding model loaded');
      return pipe;
    })().catch((err: unknown) => {
      this.extractor = undefined; // try again next time (e.g. the download failed)
      throw err;
    });
    return this.extractor;
  }

  private get pooling(): 'cls' | 'mean' {
    return /bge/i.test(this.o.model) ? 'cls' : 'mean';
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const extract = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = await extract(texts.slice(i, i + 16), { pooling: this.pooling, normalize: true });
      out.push(...batch.tolist());
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const extract = await this.load();
    const q = /bge/i.test(this.o.model) ? BGE_QUERY + text : text;
    return (await extract([q], { pooling: this.pooling, normalize: true })).tolist()[0]!;
  }
}

/**
 * Deterministic stand-in for tests: a hashed bag of words. Texts sharing words get similar vectors,
 * which is enough to exercise the vector half of hybrid retrieval without downloading a model.
 */
export class HashEmbedder implements Embedder {
  readonly name = 'hash';

  private vec(text: string): number[] {
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const h = createHash('sha256').update(word).digest();
      v[h.readUInt16BE(0) % EMBEDDING_DIM]! += h[2]! & 1 ? 1 : -1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vec(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vec(text);
  }
}
