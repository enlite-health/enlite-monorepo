jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { readFileSync } from 'fs';
import { resolve } from 'path';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { reportError } from '@shared/logging';
import { buildOpenApiDocument } from '@shared/openapi/document';
import { GetWorkerTransitToPatientUseCase } from '../../../application/GetWorkerTransitToPatientUseCase';
import { WorkerTransitMeController, workerTransitRateLimit } from '../WorkerTransitMeController';

const REF = '9f103f86-26dc-53ac-8c3a-92951d0e0537';

function mk(user: unknown, params: Record<string, string>, headers: Record<string, string> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ user, params, headers } as unknown as Request, { json, status } as unknown as Response];
}
const statusOf = (res: Response) => (res.status as unknown as jest.Mock).mock.calls[0][0];
const bodyOf = (res: Response) => ((res.status as unknown as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];

describe('WorkerTransitMeController.getMine', () => {
  const execute = jest.fn();
  const ctrl = new WorkerTransitMeController({ execute } as unknown as GetWorkerTransitToPatientUseCase);
  beforeEach(() => jest.clearAllMocks());

  it('T-F4-05 200 com exatamente { origin_label, routes }; uid do token, ref da rota e o hoje civil AR ao use case', async () => {
    execute.mockResolvedValueOnce({ ok: true, origin_label: 'Zona', routes: [{ mode: 'bus', duration_min: 30, steps: [{ line: '50', from: 'A', to: 'B' }] }] });
    const [req, res] = mk({ uid: 'uid-token' }, { patientRef: REF }, { 'x-auth-uid': 'OUTRO' });
    await ctrl.getMine(req, res);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res)).toEqual({ origin_label: 'Zona', routes: [{ mode: 'bus', duration_min: 30, steps: [{ line: '50', from: 'A', to: 'B' }] }] });
    expect(execute.mock.calls[0][0]).toBe('uid-token');
    expect(execute.mock.calls[0][1]).toBe(REF);
    expect(execute.mock.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('T-F4-05 o hoje é a data civil de Buenos Aires: 2026-11-08T02:59:59Z → 2026-11-07; 03:00:00Z → 2026-11-08', async () => {
    for (const [instante, hoje] of [['2026-11-08T02:59:59Z', '2026-11-07'], ['2026-11-08T03:00:00Z', '2026-11-08']]) {
      execute.mockResolvedValueOnce({ ok: true, origin_label: 'Zona', routes: [] });
      const c = new WorkerTransitMeController({ execute } as unknown as GetWorkerTransitToPatientUseCase, () => new Date(instante));
      const [req, res] = mk({ uid: 'uid-token' }, { patientRef: REF });
      await c.getMine(req, res);
      expect(execute.mock.calls[execute.mock.calls.length - 1][2]).toBe(hoje);
    }
  });

  it.each([['ACCOUNT_INACTIVE', 403], ['ADDRESS_NOT_AVAILABLE', 404], ['NO_SERVICE_AREA', 409]])('T-F4-05 %s → %d só com { code }', async (code, st) => {
    execute.mockResolvedValueOnce({ ok: false, code });
    const [req, res] = mk({ uid: 'uid-token' }, { patientRef: REF });
    await ctrl.getMine(req, res);
    expect(statusOf(res)).toBe(st);
    expect(bodyOf(res)).toEqual({ code });
  });

  it('T-F4-05 500 sem detalhe em erro inesperado; sem req.user → 401 sem chamar o use case', async () => {
    execute.mockRejectedValueOnce(new Error('segredo interno'));
    const [req, res] = mk({ uid: 'uid-token' }, { patientRef: REF });
    await ctrl.getMine(req, res);
    expect(statusOf(res)).toBe(500);
    expect(JSON.stringify(bodyOf(res))).not.toContain('segredo');
    expect(reportError).toHaveBeenCalled();
    const [req2, res2] = mk(undefined, { patientRef: REF });
    await ctrl.getMine(req2, res2);
    expect(statusOf(res2)).toBe(401);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('workerTransitRateLimit (30/h por prestador)', () => {
  it('T-F4-05 a 31ª consulta do mesmo uid dá 429 RATE_LIMITED; outro uid segue 200 (chave por uid, não por IP)', async () => {
    const app = express();
    // Dublê do requireAuth: o uid vem de um cabeçalho SÓ deste teste (o limitador lê `req.user.uid`).
    app.get('/t', (req, _res, next) => { (req as unknown as { user: { uid: string } }).user = { uid: String(req.headers['x-teste-uid']) }; next(); }, workerTransitRateLimit, (_req, res) => { res.status(200).json({ ok: true }); });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await request(app).get('/t').set('x-teste-uid', 'uid-a')).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    const r32 = await request(app).get('/t').set('x-teste-uid', 'uid-a');
    expect(codes[30]).toBe(429);
    expect(r32.status).toBe(429);
    expect(r32.body).toEqual({ code: 'RATE_LIMITED' });
    expect((await request(app).get('/t').set('x-teste-uid', 'uid-b')).status).toBe(200);
  });
});

const INDEX = readFileSync(resolve(__dirname, '../../../../../index.ts'), 'utf8');
const rota = (verbo: string, path: string): string[] => INDEX.split('\n').filter((l) => l.startsWith(`app.${verbo}('${path}'`));

describe('rota GET /api/workers/me/patients/:patientRef/transit em index.ts', () => {
  it("T-F4-05 é 1 linha com routeClass('client-policy'), requireAuth, worker:read e o teto por prestador, e chama getMine", () => {
    const linhas = rota('get', '/api/workers/me/patients/:patientRef/transit');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain(
      "'/api/workers/me/patients/:patientRef/transit', routeClass('client-policy'), authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'read'), workerTransitRateLimit,",
    );
    expect(INDEX).toContain('  workerTransitMeController.getMine(req, res);');
  });

  it('T-F4-05 o OpenAPI publica a rota com 200, 403, 404, 409 e 429', () => {
    const op = buildOpenApiDocument().paths['/api/workers/me/patients/{patientRef}/transit'] as { get: { responses: Record<string, unknown> } };
    expect(Object.keys(op.get.responses).sort()).toEqual(['200', '401', '403', '404', '409', '429', '500']);
    expect(JSON.stringify(op)).toContain('"origin_label"');
  });
});
