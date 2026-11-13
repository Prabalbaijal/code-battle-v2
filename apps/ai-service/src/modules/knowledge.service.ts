import type { Citation, Note, NoteSummary } from '@cb/contracts';
import { withTransaction, type Db } from '@cb/db';
import { notFound } from '@cb/errors';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Upstreams } from '../clients.js';
import { chunks, documents } from '../db/schema.js';
import type { Embedder } from '../llm/embedder.js';
import { problemText } from './problem-text.js';

/** content/dsa sits two levels above both src/modules and dist/modules. */
export const NOTES_DIR = fileURLToPath(new URL('../../content/dsa', import.meta.url));

const CHUNK_CHARS = 1800; // ≈ 450 tokens
const OVERLAP_CHARS = 270; // 15 %
const RRF_K = 60;

export interface Passage {
  n: number;
  title: string;
  heading: string;
  content: string;
  citation: Citation;
}

interface Chunk {
  heading: string;
  anchor: string | null;
  content: string;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Front matter (`title:`, `tags: a, b`) + Markdown body. */
export function parseNote(slug: string, source: string): Note {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  const head = m?.[1] ?? '';
  const title = /^title:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? slug;
  const tags = (/^tags:\s*(.+)$/m.exec(head)?.[1] ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return { slug, title, tags, markdown: (m?.[2] ?? source).trim() };
}

/**
 * Heading-aware chunking (plan §22.2 #3): split on `##`/`###`, keep each section's heading with
 * it, and cut long sections into ~450-token pieces with 15 % overlap on paragraph boundaries.
 */
export function chunkMarkdown(markdown: string): Chunk[] {
  const sections: { heading: string; body: string }[] = [];
  let current = { heading: 'Overview', body: '' };
  for (const line of markdown.split('\n')) {
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      if (current.body.trim()) sections.push(current);
      current = { heading: h[2]!.trim(), body: '' };
    } else {
      current.body += `${line}\n`;
    }
  }
  if (current.body.trim()) sections.push(current);

  const out: Chunk[] = [];
  for (const s of sections) {
    const anchor = slugify(s.heading) || null;
    const paras = s.body.trim().split(/\n{2,}/);
    let buf = '';
    for (const p of paras) {
      if (buf && buf.length + p.length > CHUNK_CHARS) {
        out.push({ heading: s.heading, anchor, content: buf.trim() });
        buf = `${buf.slice(-OVERLAP_CHARS)}\n\n`;
      }
      buf += `${p}\n\n`;
    }
    if (buf.trim()) out.push({ heading: s.heading, anchor, content: buf.trim() });
  }
  return out;
}

export class KnowledgeService {
  private notesCache: Note[] | undefined;

  constructor(
    private readonly d: {
      db: Db;
      embedder: Embedder;
      upstreams: Upstreams;
      logger: Logger;
      notesDir?: string;
    },
  ) {}

  // ---------------- notes (served to /learn and indexed for the tutor) ----------------

  notes(): Note[] {
    this.notesCache ??= readdirSync(this.d.notesDir ?? NOTES_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => parseNote(f.slice(0, -3), readFileSync(join(this.d.notesDir ?? NOTES_DIR, f), 'utf8')));
    return this.notesCache;
  }

  noteSummaries(): NoteSummary[] {
    return this.notes().map(({ slug, title, tags }) => ({ slug, title, tags }));
  }

  note(slug: string): Note {
    const n = this.notes().find((x) => x.slug === slug);
    if (!n) throw notFound('Note');
    return n;
  }

  // ---------------- ingestion ----------------

  /** On worker boot: (re)index every note whose text changed. */
  async ingestNotes(): Promise<number> {
    let changed = 0;
    for (const n of this.notes()) {
      const ok = await this.upsert('note', n.slug, n.title, n.tags, n.markdown, (c) =>
        c.anchor ? `/learn/${n.slug}#${c.anchor}` : `/learn/${n.slug}`,
      );
      if (ok) changed++;
    }
    return changed;
  }

  /** A published problem's statement (public parts only); removed when it leaves the catalog. */
  async ingestProblem(problemId: string, slug: string): Promise<void> {
    const p = await this.d.upstreams.problem(slug);
    if (!p) {
      await this.d.db
        .delete(documents)
        .where(and(eq(documents.kind, 'problem'), eq(documents.ref, problemId)));
      return;
    }
    await this.upsert('problem', problemId, p.title, p.tags, problemText(p), () => null);
  }

  private async upsert(
    kind: 'note' | 'problem',
    ref: string,
    title: string,
    tags: string[],
    text: string,
    anchorOf: (c: Chunk) => string | null,
  ): Promise<boolean> {
    const hash = createHash('sha256')
      .update(`${title}\n${tags.join(',')}\n${text}`)
      .digest('hex');
    const [old] = await this.d.db
      .select({ id: documents.id, hash: documents.sourceHash })
      .from(documents)
      .where(and(eq(documents.kind, kind), eq(documents.ref, ref)));
    if (old?.hash === hash) return false;

    const parts = chunkMarkdown(text);
    // embed before the transaction: it's the slow part (and may download the model the first time)
    const vectors = await this.d.embedder.embedDocuments(
      parts.map((c) => `${title} — ${c.heading}\n${c.content}`),
    );
    await withTransaction(this.d.db, async (tx) => {
      if (old) await tx.delete(documents).where(eq(documents.id, old.id)); // chunks cascade
      const docId = newId();
      await tx.insert(documents).values({ id: docId, kind, ref, title, tags, sourceHash: hash });
      if (parts.length) {
        await tx.insert(chunks).values(
          parts.map((c, i) => ({
            id: newId(),
            documentId: docId,
            ordinal: i,
            heading: c.heading,
            anchor: anchorOf(c),
            content: c.content,
            embedding: vectors[i]!,
          })),
        );
      }
    });
    this.d.logger.info({ kind, ref, chunks: parts.length }, 'document indexed');
    return true;
  }

  // ---------------- retrieval ----------------

  /**
   * Hybrid retrieval: Postgres full-text (exact terms: "prefix sum", "TLE") and pgvector cosine
   * (meaning: "my loop is too slow"), each ranked, fused with Reciprocal Rank Fusion
   * (score = Σ 1/(60 + rank)), top k. Problem statements are only searchable by players who have
   * already played that problem, so the tutor never previews a problem someone may still get.
   */
  async search(query: string, opts: { k?: number; allowedProblemIds: string[] }): Promise<Passage[]> {
    const k = opts.k ?? 8;
    const qvec = await this.d.embedder.embedQuery(query);
    const vec = `[${qvec.join(',')}]`;
    const allowed = opts.allowedProblemIds;
    const visible = allowed.length
      ? sql`(d.kind = 'note' or (d.kind = 'problem' and d.ref = any(array[${sql.join(
          allowed.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[])))`
      : sql`d.kind = 'note'`;
    const rows = await this.d.db.execute<{
      id: string;
      title: string;
      kind: 'note' | 'problem';
      heading: string;
      anchor: string | null;
      content: string;
      score: number;
    }>(sql`
      with vec as (
        select c.id, row_number() over (order by c.embedding <=> ${vec}::vector) as r
        from chunks c join documents d on d.id = c.document_id
        where ${visible}
        order by c.embedding <=> ${vec}::vector
        limit 20
      ),
      fts as (
        select c.id, row_number() over (order by ts_rank_cd(c.tsv, q) desc) as r
        from chunks c join documents d on d.id = c.document_id, websearch_to_tsquery('english', ${query}) q
        where c.tsv @@ q and ${visible}
        order by ts_rank_cd(c.tsv, q) desc
        limit 20
      ),
      fused as (
        select id, sum(1.0 / (${RRF_K} + r)) as score
        from (select * from vec union all select * from fts) u
        group by id
      )
      select c.id, d.title, d.kind, c.heading, c.anchor, c.content, f.score
      from fused f join chunks c on c.id = f.id join documents d on d.id = c.document_id
      order by f.score desc
      limit ${k}`);
    return rows.rows.map((r, i) => ({
      n: i + 1,
      title: r.title,
      heading: r.heading,
      content: r.content,
      citation: {
        n: i + 1,
        title: r.heading && r.heading !== 'Overview' ? `${r.title} — ${r.heading}` : r.title,
        kind: r.kind,
        href: r.anchor,
      },
    }));
  }
}
