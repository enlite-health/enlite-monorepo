/**
 * PatientReconciliationController — rotas admin da reconciliação (spec 003).
 *
 * H1 (T016): snapshot por fonte (ClickUp / Ana Care, ambas por API), rodadas,
 * inventário. Rotas de H2-H5 respondem 501 até as tasks correspondentes.
 *
 * Regras: envelope `{ success, data | error }`; actor do token, nunca do body;
 * erro nunca ecoa valor de campo; o único endpoint que devolve nome/nascimento
 * é `GET /inventory/:set` (identificação, não clínico) — marcado 🔒.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger, reportError } from '@shared/logging';
import { COUNTRIES, SOURCES, type Country, type InventoryBucket, type Source } from '../../domain/enums';
import type { SnapshotSourceWithLockUseCase } from '../../application/SnapshotSourceWithLockUseCase';
import type { ClassifySourcesUseCase } from '../../application/ClassifySourcesUseCase';
import type { SourceRunRepository } from '../../infrastructure/SourceRunRepository';
import type { IdentityLinkRepository } from '../../infrastructure/IdentityLinkRepository';
import type { SnapshotRepository } from '../../infrastructure/SnapshotRepository';

const log = logger.child({ source: 'PatientReconciliationController' });

// ── Zod schemas ────────────────────────────────────────────────────────────
const CountrySchema = z.enum(COUNTRIES);
const CountryBodySchema = z.object({ country: CountrySchema.default('AR') });
const RunsQuerySchema = z.object({
  source: z.enum(SOURCES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
const CountryQuerySchema = z.object({ country: CountrySchema.default('AR') });
const BucketParamSchema = z.object({ set: z.enum(['only-clickup', 'only-anacare', 'both', 'ambiguous']) });
const PageQuerySchema = z.object({
  country: CountrySchema.default('AR'),
  page: z.coerce.number().int().min(1).optional().default(1),
  size: z.coerce.number().int().min(1).max(200).optional().default(50),
});
const SET_TO_BUCKET: Record<string, InventoryBucket> = {
  'only-clickup': 'ONLY_CLICKUP', 'only-anacare': 'ONLY_ANACARE', both: 'BOTH', ambiguous: 'AMBIGUOUS',
};

export interface ControllerDeps {
  snapshot: () => Promise<Pick<SnapshotSourceWithLockUseCase, 'execute'>>;
  classify: () => Promise<Pick<ClassifySourcesUseCase, 'execute'>>;
  runs: Pick<SourceRunRepository, 'list' | 'findById'>;
  links: Pick<IdentityLinkRepository, 'inventoryCounts' | 'listByBucket'>;
  snapshots: Pick<SnapshotRepository, 'countByRun'>;
}

export class PatientReconciliationController {
  constructor(private readonly deps: ControllerDeps) {}

  /** POST /runs/clickup e POST /runs/anacare — snapshot manual de uma fonte (lock; 409 se ocupado). */
  snapshotSource(source: Source) {
    return async (req: Request, res: Response): Promise<void> => {
      const body = CountryBodySchema.safeParse(req.body ?? {});
      if (!body.success) { res.status(400).json({ success: false, error: body.error.flatten() }); return; }
      try {
        const useCase = await this.deps.snapshot();
        const out = await useCase.execute({ source, country: body.data.country, triggeredBy: 'MANUAL', actorId: actorId(req) });
        if (out.kind === 'BUSY') { res.status(409).json({ success: false, error: 'already_running' }); return; }
        const { run, counters } = out.result;
        if (run.completeness !== 'FAILED') {
          const classify = await this.deps.classify();
          await classify.execute({ country: body.data.country });
        }
        const status = run.completeness === 'FAILED' ? 422 : 202;
        res.status(status).json({ success: status === 202, data: {
          runId: run.id, source, completeness: run.completeness, expectedCount: run.expectedCount, readCount: run.readCount,
          counters, error: run.error,
        } });
      } catch (err) {
        this.handleError(err, res, `snapshotSource:${source}`);
      }
    };
  }

  async listRuns(req: Request, res: Response): Promise<void> {
    const q = RunsQuerySchema.safeParse(req.query);
    if (!q.success) { res.status(400).json({ success: false, error: q.error.flatten() }); return; }
    try {
      res.json({ success: true, data: await this.deps.runs.list(q.data) });
    } catch (err) { this.handleError(err, res, 'listRuns'); }
  }

  async getRun(req: Request, res: Response): Promise<void> {
    try {
      const run = await this.deps.runs.findById(req.params.id);
      if (!run) { res.status(404).json({ success: false, error: 'not_found' }); return; }
      const [snapshots, counts] = await Promise.all([
        this.deps.snapshots.countByRun(run.id),
        this.deps.links.inventoryCounts(run.country as Country),
      ]);
      res.json({ success: true, data: { ...run, snapshots, counts } });
    } catch (err) { this.handleError(err, res, 'getRun'); }
  }

  async inventory(req: Request, res: Response): Promise<void> {
    const q = CountryQuerySchema.safeParse(req.query);
    if (!q.success) { res.status(400).json({ success: false, error: q.error.flatten() }); return; }
    try {
      const [counts, runs] = await Promise.all([
        this.deps.links.inventoryCounts(q.data.country),
        this.deps.runs.list({ limit: 20 }),
      ]);
      const latest = (s: Source) => runs.find(r => r.source === s && r.completeness !== 'FAILED') ?? null;
      const lastAny = (s: Source) => runs.find(r => r.source === s) ?? null;
      const c = latest('CLICKUP'), a = latest('ANACARE');
      res.json({ success: true, data: {
        country: q.data.country, counts,
        runPair: { clickupRunId: c?.id ?? null, anacareRunId: a?.id ?? null },
        completeness: { clickup: c?.completeness ?? 'NONE', anacare: a?.completeness ?? 'NONE' },
        lastReadAt: { clickup: c?.finishedAt ?? null, anacare: a?.finishedAt ?? null },
        lastError: { clickup: lastAny('CLICKUP')?.error ?? null, anacare: lastAny('ANACARE')?.error ?? null },
      } });
    } catch (err) { this.handleError(err, res, 'inventory'); }
  }

  /** 🔒 GET /inventory/:set — identificação (nome/nascimento via link), sem clínico. */
  async inventorySet(req: Request, res: Response): Promise<void> {
    const p = BucketParamSchema.safeParse(req.params);
    const q = PageQuerySchema.safeParse(req.query);
    if (!p.success || !q.success) { res.status(400).json({ success: false, error: 'invalid_params' }); return; }
    try {
      const { items, total } = await this.deps.links.listByBucket(q.data.country, SET_TO_BUCKET[p.data.set], q.data.page, q.data.size);
      log.info({ msg: 'inventory_set_read', actor: actorId(req), set: p.data.set, count: items.length });
      res.json({ success: true, data: { items, page: q.data.page, size: q.data.size, total } });
    } catch (err) { this.handleError(err, res, 'inventorySet'); }
  }

  notImplemented(_req: Request, res: Response): void {
    res.status(501).json({ success: false, error: 'not_implemented_yet' });
  }

  private handleError(err: unknown, res: Response, method: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `PatientReconciliationController:${method}` });
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
}

function actorId(req: Request): string | null {
  const user = (req as Request & { user?: { uid?: string } }).user;
  return user?.uid ?? null;
}
