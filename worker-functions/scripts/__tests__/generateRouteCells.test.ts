/**
 * T034 (change 081): route-cells.json = o que o scanExpressRouter produz AGORA para as rotas
 * que as irmãs da Maria chamam. Falha se o JSON divergir da varredura ou do mapa.
 */
import fs from 'fs';
import { gerarRouteCells, serializar, ROUTE_CELLS_PATH } from '../generateRouteCells';

/**
 * CONTRATO das rotas de staff de vínculo (T113 define, T111 implementa os handlers):
 *   GET  /api/admin/area-memberships?personId=|?uid=   -> célula area_membership:read
 *   POST /api/admin/area-memberships {personId,area,role} -> célula area_membership:write
 *   POST /api/admin/area-memberships/:id/revoke {reason}  -> célula area_membership:write
 * Arquivo: src/modules/identity/interfaces/adminAreaMembershipRoutes.ts, `createAdminAreaMembershipRoutes(auth, perm,
 * handlers)`, família `admin.users`, `staffOnly` antes de `perm.require`, célula LITERAL (nunca em closure).
 * Sync do catálogo: as células entram por `declaredCells(routes)` no boot (wirePermissionsModule, flag
 * PERMISSION_CATALOG_SYNC_ENABLED) — sem migration; nenhum grupo recebe a célula (ato da operação).
 */
const ESPERADO: Record<string, string> = {
  'GET /api/admin/workers/:id': 'worker:read',
  'GET /api/admin/workers/:id#documents': 'worker_document:read',
  'GET /api/workers/:id/encuadres': 'match:read',
  'GET /api/admin/workers/:id/current-interview': 'interview:read',
  'GET /api/admin/workers/:id/available-vacancies': 'vacancy:read',
  'GET /api/admin/vacancies/:id': 'vacancy:read',
  'GET /api/admin/vacancies/:id/interview-slots': 'interview:read',
  'GET /api/admin/workers': 'worker:read',
  'GET /api/admin/recruitment/activity-per-person': 'recruitment_activity_per_person:read',
  'GET /api/admin/assistants/count/workers': 'worker:read',
  'GET /api/admin/assistants/count/patients': 'patient:read',
  'GET /api/admin/assistants/count/vacancies': 'vacancy:read',
  'GET /api/admin/area-memberships': 'area_membership:read',
  'POST /api/admin/area-memberships': 'area_membership:write',
  'POST /api/admin/area-memberships/:id/revoke': 'area_membership:write',
};

describe('route-cells.json (inventário das irmãs da Maria)', () => {
  const commitado = JSON.parse(fs.readFileSync(ROUTE_CELLS_PATH, 'utf8')) as {
    routes: Array<{ method: string; path: string; cell: string; bloco?: string }>;
  };
  const nome = (r: { method: string; path: string; bloco?: string }) =>
    `${r.method} ${r.path}${r.bloco ? `#${r.bloco}` : ''}`;

  it('tem exatamente as 15 entradas do mapa, cada uma com a célula esperada', () => {
    expect(commitado.routes).toHaveLength(15);
    expect(Object.fromEntries(commitado.routes.map((r) => [nome(r), r.cell]))).toEqual(ESPERADO);
  });

  it('é idêntico ao que a varredura produz agora (regenerar em memória)', async () => {
    const agora = serializar(await gerarRouteCells());
    expect(fs.readFileSync(ROUTE_CELLS_PATH, 'utf8')).toBe(agora);
  });
});
