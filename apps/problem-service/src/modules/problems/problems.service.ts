import {
  problemEvents,
  type AdminProblem,
  type CreateProblemBody,
  type JudgeSpec,
  type PublicProblem,
  type PutTestFileBody,
  type ReferenceSolutionBody,
  type SelectionResult,
  type UpdateProblemBody,
} from '@cb/contracts';
import { isUniqueViolation, withTransaction, type Db, type Tx } from '@cb/db';
import { AppError, conflict, notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import { describePackProblem, validatePack } from '@cb/judge-core';
import { z } from 'zod';
import type { ProblemRow } from '../../db/schema.js';
import type { BlobStore } from '../../lib/blobs.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { toAdmin, toPublic } from './problems.dto.js';
import { problemsRepository as repo } from './problems.repository.js';
import { publishBlockers } from './publish-rules.js';

export interface ProblemServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  blobs: BlobStore;
  /** Base URL other services use to fetch blobs (`/internal/blobs/<key>`). */
  selfUrl: string;
  afterCommit?: () => void;
}

/** Fields whose change alters verdicts: new version, recalibration, unpublish (plan §9.3). */
const LIMIT_FIELDS = ['memoryLimitKb', 'outputLimitKb', 'checkerType', 'floatEps'] as const;
const keyset = z.object({ t: z.string().max(40), id: z.uuid() });

export class ProblemService {
  constructor(private readonly d: ProblemServiceDeps) {}

  // ---------------- admin ----------------

  async create(userId: string, body: CreateProblemBody): Promise<AdminProblem> {
    try {
      const p = await repo.insert(this.d.db, {
        id: newId(),
        ...body,
        examples: body.examples.map((e) => ({ ...e })),
        createdBy: userId,
      });
      return toAdmin(p, [], [], []);
    } catch (err) {
      if (isUniqueViolation(err, 'problems_slug_key'))
        throw conflict('SLUG_TAKEN', 'A problem with this slug exists');
      throw err;
    }
  }

  async get(id: string): Promise<AdminProblem> {
    const p = await repo.findById(this.d.db, id);
    if (!p) throw notFound('Problem');
    return this.adminView(this.d.db, p);
  }

  async list(cursor: string | undefined, limit: number) {
    const after = decodeCursor(keyset, cursor);
    const rows = await repo.list(this.d.db, after, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(({ ts: _ts, updatedAt, ...r }) => ({ ...r, updatedAt: updatedAt.toISOString() })),
      nextCursor: rows.length > limit && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
    };
  }

  async update(id: string, body: UpdateProblemBody): Promise<AdminProblem> {
    return this.mutate(id, async (tx, p) => {
      const touchesLimits = LIMIT_FIELDS.some((k) => k in body && body[k] !== p[k]);
      const checker = body.checkerType ?? p.checkerType;
      const eps = 'floatEps' in body ? body.floatEps : p.floatEps;
      if (checker === 'float' && (eps === null || eps === undefined)) {
        throw new AppError('VALIDATION_FAILED', 400, 'float checker needs floatEps', {
          details: [{ path: '/floatEps', message: 'float checker needs floatEps' }],
        });
      }
      let next = await repo.update(tx, id, {
        ...body,
        ...(body.examples ? { examples: body.examples.map((e) => ({ ...e })) } : {}),
      });
      if (touchesLimits) next = await repo.invalidate(tx, id);
      await this.emitUpdated(tx, next, touchesLimits ? 'limits' : 'statement');
      return next;
    });
  }

  /** Upload or replace one packed file (ordinal 1–4). Validated with judge-core before storing. */
  async putTestFile(id: string, ordinal: number, body: PutTestFileBody): Promise<AdminProblem> {
    const v = validatePack(body.input, body.output, body.outputCaseLineCounts);
    if (!v.ok) {
      throw new AppError('TEST_PACK_INVALID', 422, describePackProblem(v.problems[0]!), {
        details: v.problems.map((p) => ({ ...p, message: describePackProblem(p) })),
      });
    }
    return this.mutate(id, async (tx) => {
      const input = await this.d.blobs.put(tx, body.input);
      const output = await this.d.blobs.put(tx, body.output);
      await repo.upsertFile(tx, {
        problemId: id,
        ordinal,
        kind: body.kind,
        caseCount: v.pack.caseCount,
        inputUri: input.key,
        outputUri: output.key,
        outputCaseLineCounts: body.outputCaseLineCounts,
        inputBytes: input.size,
        sha256: input.sha256,
      });
      const next = await repo.invalidate(tx, id);
      await this.emitUpdated(tx, next, 'tests');
      return next;
    });
  }

  async deleteTestFile(id: string, ordinal: number): Promise<AdminProblem> {
    return this.mutate(id, async (tx) => {
      if (!(await repo.deleteFile(tx, id, ordinal))) throw notFound('Test file');
      const next = await repo.invalidate(tx, id);
      await this.emitUpdated(tx, next, 'tests');
      return next;
    });
  }

  /** Reference solutions feed calibration; they don't change the published version by themselves. */
  async addReference(id: string, body: ReferenceSolutionBody): Promise<AdminProblem> {
    return this.mutate(id, async (tx, p) => {
      const code = await this.d.blobs.put(tx, body.code);
      await repo.insertReference(tx, {
        id: newId(),
        problemId: id,
        languageKey: body.languageKey,
        expectedVerdict: body.expectedVerdict,
        codeUri: code.key,
      });
      return p;
    });
  }

  async deleteReference(id: string, referenceId: string): Promise<AdminProblem> {
    return this.mutate(id, async (tx, p) => {
      if (!(await repo.deleteReference(tx, id, referenceId))) throw notFound('Reference solution');
      return p;
    });
  }

  /** Calibration result (plan §14.7): limits for every file × language; marks the version calibrated. */
  async applyCalibration(
    id: string,
    version: number,
    limits: { ordinal: number; languageKey: string; cpuLimitMs: number }[],
  ): Promise<AdminProblem> {
    return this.mutate(id, async (tx, p) => {
      if (p.version !== version)
        throw conflict('CONFLICT', 'Problem changed during calibration; run it again');
      await repo.replaceLimits(tx, id, limits);
      return repo.update(tx, id, { calibratedAt: new Date() });
    });
  }

  async publish(id: string): Promise<AdminProblem> {
    return this.mutate(id, async (tx, p) => {
      if (p.status === 'published') return p;
      const [files, refs, limits] = await Promise.all([
        repo.files(tx, id),
        repo.references(tx, id),
        repo.limits(tx, id),
      ]);
      const blockers = publishBlockers({
        status: p.status,
        exampleCount: p.examples.length,
        files,
        references: refs,
        limits,
        calibratedAt: p.calibratedAt,
      });
      if (blockers.length) {
        throw new AppError('PROBLEM_NOT_PUBLISHABLE', 422, 'Problem is not ready to publish', {
          details: blockers,
        });
      }
      // version++ on publish invalidates verdict caches (plan §14.7); limits stay attached.
      const next = await repo.update(tx, id, { status: 'published', version: p.version + 1 });
      await this.d.outbox.add(tx, problemEvents.problemPublishedV1, {
        key: id,
        data: {
          problemId: id,
          slug: next.slug,
          version: next.version,
          difficulty: next.difficulty,
          tags: next.tags,
        },
      });
      return next;
    });
  }

  async archive(id: string): Promise<AdminProblem> {
    return this.mutate(id, async (tx, p) => {
      if (p.status === 'archived') return p;
      const next = await repo.update(tx, id, { status: 'archived' });
      await this.emitUpdated(tx, next, 'status');
      return next;
    });
  }

  // ---------------- public ----------------

  async publicBySlug(slug: string): Promise<PublicProblem> {
    const p = await repo.findPublishedBySlug(this.d.db, slug);
    if (!p) throw notFound('Problem');
    return toPublic(p, await repo.limits(this.d.db, p.id));
  }

  // ---------------- internal ----------------

  /**
   * One problem per match, idempotent by matchId (plan §11.2). The match row is inserted before
   * the "seen" rows, so a concurrent duplicate call can't mark a second problem as seen.
   */
  async select(matchId: string, userIds: string[], difficulty?: string): Promise<SelectionResult> {
    const ids = [...new Set(userIds)];
    const result = await withTransaction(this.d.db, async (tx) => {
      const existing = await repo.findSelection(tx, matchId);
      if (existing) return existing;
      const pick = await repo.pickUnseen(tx, ids, difficulty);
      if (!pick) {
        // A concurrent call for the same match may have committed (and marked its pick as seen)
        // after our first read: that's a replay, not "nothing left".
        const raced = await repo.findSelection(tx, matchId);
        if (raced) return raced;
        throw conflict('NO_UNSEEN_PROBLEM', 'No published problem that both players haven’t seen');
      }
      if (!(await repo.insertSelection(tx, matchId, pick.id)))
        return (await repo.findSelection(tx, matchId))!;
      await repo.markSeen(tx, ids, pick.id);
      return pick.id;
    });
    const p = await repo.findById(this.d.db, result);
    return { matchId, problemId: result, slug: p!.slug };
  }

  /** Safety net from `battle.match.started.v1` (idempotent). */
  async markSeen(tx: Tx, userIds: string[], problemId: string): Promise<void> {
    await repo.markSeen(tx, userIds, problemId);
  }

  async judgeSpec(id: string): Promise<JudgeSpec> {
    const p = await repo.findById(this.d.db, id);
    if (!p || p.status === 'archived') throw notFound('Problem');
    const [files, limits] = await Promise.all([repo.files(this.d.db, id), repo.limits(this.d.db, id)]);
    const url = (key: string) => `${this.d.selfUrl.replace(/\/$/, '')}/internal/blobs/${key}`;
    return {
      problemId: p.id,
      version: p.version,
      status: p.status,
      checker: { type: p.checkerType, eps: p.floatEps },
      memoryLimitKb: p.memoryLimitKb,
      outputLimitKb: p.outputLimitKb,
      files: files.map((f) => ({
        ordinal: f.ordinal,
        kind: f.kind,
        caseCount: f.caseCount,
        outputCaseLineCounts: f.outputCaseLineCounts,
        sha256: f.sha256,
        inputUrl: url(f.inputUri),
        outputUrl: url(f.outputUri),
        cpuLimitMs: Object.fromEntries(
          limits.filter((l) => l.ordinal === f.ordinal).map((l) => [l.languageKey, l.cpuLimitMs]),
        ),
      })),
    };
  }

  async blob(key: string): Promise<Buffer> {
    const b = await this.d.blobs.get(this.d.db, key);
    if (!b) throw notFound('Blob');
    return b;
  }

  // ---------------- helpers ----------------

  /** Lock the problem row, run the change, return the fresh admin view. */
  private async mutate(
    id: string,
    fn: (tx: Tx, p: ProblemRow) => Promise<ProblemRow>,
  ): Promise<AdminProblem> {
    const view = await withTransaction(this.d.db, async (tx) => {
      const p = await repo.findById(tx, id, { forUpdate: true });
      if (!p) throw notFound('Problem');
      const next = await fn(tx, p);
      return this.adminView(tx, next);
    });
    this.d.afterCommit?.();
    return view;
  }

  private async adminView(ex: Db | Tx, p: ProblemRow): Promise<AdminProblem> {
    const [files, refs, limits] = await Promise.all([
      repo.files(ex, p.id),
      repo.references(ex, p.id),
      repo.limits(ex, p.id),
    ]);
    return toAdmin(p, files, refs, limits);
  }

  private async emitUpdated(tx: Tx, p: ProblemRow, change: 'statement' | 'tests' | 'limits' | 'status') {
    await this.d.outbox.add(tx, problemEvents.problemUpdatedV1, {
      key: p.id,
      data: { problemId: p.id, slug: p.slug, version: p.version, status: p.status, change },
    });
  }
}
