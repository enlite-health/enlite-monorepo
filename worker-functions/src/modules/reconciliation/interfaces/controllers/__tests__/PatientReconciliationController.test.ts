/**
 * PatientReconciliationController — T016 (unitário; o e2e com stack sobe na T038).
 * Cobre: snapshot de fonte → 202 + classify; fonte FAILED (ex.: API do Ana Care
 * indisponível) → 422 sem classify, erro declarado; BUSY → 409; inventory →
 * contagens + completude + lastError; inventory/:set inválido → 400; erro
 * interno nunca ecoa mensagem; 501 nas rotas futuras. Fixture sintética.
 */
// ── Mocks (before imports) ──
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: (...a: unknown[]) => mockReportError(...a),
  loggingAls: { run: jest.fn() },
}));

import type { Request, Response } from 'express';
import { PatientReconciliationController } from '../PatientReconciliationController';

function res() {
  const r: Partial<Response> & { body?: unknown; code?: number } = {};
  r.status = jest.fn().mockImplementation((c: number) => { r.code = c; return r as Response; });
  r.json = jest.fn().mockImplementation((b: unknown) => { r.body = b; r.code ??= 200; return r as Response; });
  return r as Response & { body?: unknown; code?: number };
}
function req(over: Record<string, unknown> = {}): Request {
  return { body: {}, query: {}, params: {}, headers: {}, user: { uid: 'admin-1' }, ...over } as unknown as Request;
}

const run = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'run-1', source: 'ANACARE', country: 'AR', completeness: 'COMPLETE', readCount: 10, expectedCount: 10, error: null, finishedAt: new Date(), ...over,
});
const counters = { CREATED: 10, REPLACED: 0, UNCHANGED: 0, skipped: 0, forbidden: 0 };

function build(over: Partial<ConstructorParameters<typeof PatientReconciliationController>[0]> = {}) {
  const snapshot = { execute: jest.fn().mockResolvedValue({ kind: 'DONE', result: { run: run(), counters } }) };
  const classify = { execute: jest.fn().mockResolvedValue({}) };
  const deps = {
    snapshot: async () => snapshot,
    classify: async () => classify,
    runs: {
      list: jest.fn().mockResolvedValue([
        run({ source: 'CLICKUP', id: 'c1' }),
        run({ id: 'a-failed', completeness: 'FAILED', error: 'anacare_patient_api_unavailable' }),
        run({ id: 'a1', completeness: 'PARTIAL' }),
      ]),
      findById: jest.fn().mockResolvedValue(run()),
    },
    links: { inventoryCounts: jest.fn().mockResolvedValue({ onlyClickup: 4, onlyAnacare: 3, both: 5, ambiguous: 2, total: 14 }), listByBucket: jest.fn().mockResolvedValue({ items: [], total: 0 }) },
    snapshots: { countByRun: jest.fn().mockResolvedValue(10) },
    ...over,
  };
  return { ctrl: new PatientReconciliationController(deps), snapshot, classify, deps };
}

describe('PatientReconciliationController', () => {
  it('POST /runs/anacare ok → 202, fonte no use case, actor do token, classify disparado', async () => {
    const { ctrl, snapshot, classify } = build(); const r = res();
    await ctrl.snapshotSource('ANACARE')(req({ body: { country: 'AR' } }), r);
    expect(r.code).toBe(202);
    expect(snapshot.execute).toHaveBeenCalledWith(expect.objectContaining({ source: 'ANACARE', country: 'AR', triggeredBy: 'MANUAL', actorId: 'admin-1' }));
    expect(classify.execute).toHaveBeenCalledWith({ country: 'AR' });
  });

  it('fonte FAILED (API do Ana Care ainda não existe) → 422, erro declarado, classify NÃO roda', async () => {
    const { ctrl, snapshot, classify } = build();
    snapshot.execute.mockResolvedValueOnce({ kind: 'DONE', result: { run: run({ completeness: 'FAILED', error: 'anacare_patient_api_unavailable', readCount: 0 }), counters } });
    const r = res();
    await ctrl.snapshotSource('ANACARE')(req(), r);
    expect(r.code).toBe(422);
    expect((r.body as { success: boolean; data: { error: string } }).success).toBe(false);
    expect((r.body as { data: { error: string } }).data.error).toBe('anacare_patient_api_unavailable');
    expect(classify.execute).not.toHaveBeenCalled();
  });

  it('país inválido → 400', async () => {
    const { ctrl } = build(); const r = res();
    await ctrl.snapshotSource('CLICKUP')(req({ body: { country: 'XX' } }), r);
    expect(r.code).toBe(400);
  });

  it('rodada ocupada → 409 already_running', async () => {
    const { ctrl, snapshot } = build();
    snapshot.execute.mockResolvedValueOnce({ kind: 'BUSY' });
    const r = res();
    await ctrl.snapshotSource('CLICKUP')(req(), r);
    expect(r.code).toBe(409);
    expect((r.body as { error: string }).error).toBe('already_running');
  });

  it('inventory → contagens 4/3/5/2, par de rodadas (ignora FAILED), completude e último erro por fonte', async () => {
    const { ctrl } = build(); const r = res();
    await ctrl.inventory(req(), r);
    const data = (r.body as { data: { counts: unknown; runPair: unknown; completeness: unknown; lastError: unknown } }).data;
    expect(data.counts).toEqual({ onlyClickup: 4, onlyAnacare: 3, both: 5, ambiguous: 2, total: 14 });
    expect(data.runPair).toEqual({ clickupRunId: 'c1', anacareRunId: 'a1' });
    expect(data.completeness).toEqual({ clickup: 'COMPLETE', anacare: 'PARTIAL' });
    expect(data.lastError).toEqual({ clickup: null, anacare: 'anacare_patient_api_unavailable' });
  });

  it('inventory/:set com set inválido → 400; válido → paginado', async () => {
    const { ctrl, deps } = build();
    const bad = res();
    await ctrl.inventorySet(req({ params: { set: 'everything' } }), bad);
    expect(bad.code).toBe(400);
    const ok = res();
    await ctrl.inventorySet(req({ params: { set: 'both' }, query: { page: '2', size: '10' } }), ok);
    expect(deps.links.listByBucket).toHaveBeenCalledWith('AR', 'BOTH', 2, 10);
    expect(ok.code).toBe(200);
  });

  it('erro interno → 500 "Erro interno", nunca a mensagem; reportError chamado', async () => {
    const { ctrl, deps } = build();
    (deps.runs.list as jest.Mock).mockRejectedValueOnce(new Error('SELECT canonical ... dado'));
    const r = res();
    await ctrl.listRuns(req(), r);
    expect(r.code).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('canonical');
    expect(mockReportError).toHaveBeenCalled();
  });

  it('rotas H2-H5 respondem 501', () => {
    const { ctrl } = build(); const r = res();
    ctrl.notImplemented(req(), r);
    expect(r.code).toBe(501);
  });
});
