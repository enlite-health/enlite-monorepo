/**
 * adminDailyReportRoutes (spec 092, T204) — varre o router de VERDADE com o mesmo `scanExpressRouter` do catálogo de células e afirma a
 * célula LITERAL da rota a partir do mapa escrito à mão. A redação do texto é provada pela borda no e2e (`daily-reports-admin.e2e.test.ts`);
 * aqui, o desenho da rota e a trilha.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminDailyReportRoutes, buildAdminDailyReportController } from '../adminDailyReportRoutes';
import { AdminDailyReportController as RealController } from '../../controllers/AdminDailyReportController';
import type { AdminDailyReportController } from '../../controllers/AdminDailyReportController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const trilhas: Array<{ tipo: string; acao: string; id: string | undefined }> = [];
jest.mock('@shared/audit/resourceAccessLog', () => ({
  logResourceAccess:
    (tipo: string, acao: string | ((req: unknown) => string), idFrom: (req: unknown) => string | undefined) =>
    (req: unknown, _res: unknown, next: () => void) => {
      trilhas.push({ tipo, acao: typeof acao === 'function' ? acao(req) : acao, id: idFrom?.(req) });
      next();
    },
}));

const controller = { list: (req: express.Request, res: express.Response) => res.json({ m: 'list', patientId: req.params.patientId }) } as unknown as AdminDailyReportController;
const build = () => createAdminDailyReportRoutes(controller, authDouble(), permissionsDouble());

function app(celulas?: string[]) {
  const a = express();
  if (celulas) {
    a.use((req, _res, next) => {
      (req as express.Request & { permissionCells?: string[] }).permissionCells = celulas;
      next();
    });
  }
  a.use('/api/admin', build());
  return a;
}

describe('createAdminDailyReportRoutes', () => {
  beforeEach(() => { trilhas.length = 0; });

  it('é UMA rota só, de LEITURA, com a célula daily_report:read LITERAL; nenhuma passa sem declaração', () => {
    const rotas = scanExpressRouter(build());
    expect(undeclaredRoutes(rotas, () => true)).toEqual([]);
    expect(rotas.map((r) => `${r.method} ${r.path} ${(r.cells ?? []).map((c) => cellKey(c.resource, c.action)).join(' + ')}`)).toEqual([
      'GET /patients/:patientId/daily-reports daily_report:read',
    ]);
  });

  it('não existe rota de escrita nem de remoção do informe no painel (imutável, DC-7)', async () => {
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      await request(app())[m]('/api/admin/patients/p-1/daily-reports').expect(404);
      await request(app())[m]('/api/admin/patients/p-1/daily-reports/r-1').expect(404);
    }
  });

  it('a trilha de leitura é de PACIENTE, pelo :patientId, e diz se o texto saiu: sem a célula do texto → read_daily_reports; com ela → …:narrative', async () => {
    await request(app(['daily_report:read'])).get('/api/admin/patients/p-1/daily-reports').expect(200);
    await request(app(['daily_report:read', 'daily_report_narrative:read'])).get('/api/admin/patients/p-2/daily-reports').expect(200);
    await request(app()).get('/api/admin/patients/p-3/daily-reports').expect(200); // cells null: engine não decidiu → o texto NÃO é liberado
    expect(trilhas).toEqual([
      { tipo: 'patient', acao: 'read_daily_reports', id: 'p-1' },
      { tipo: 'patient', acao: 'read_daily_reports:narrative', id: 'p-2' },
      { tipo: 'patient', acao: 'read_daily_reports', id: 'p-3' },
    ]);
  });

  it('composition root: monta o controller real, LAZY (não abre o pool no boot)', () => {
    expect(buildAdminDailyReportController()).toBeInstanceOf(RealController);
  });
});
