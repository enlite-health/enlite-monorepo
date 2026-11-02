/**
 * T034 (change 081): route-cells.json = o que o scanExpressRouter produz AGORA para as rotas
 * que as irmãs da Maria chamam. Falha se o JSON divergir da varredura ou do mapa.
 */
import fs from 'fs';
import { gerarRouteCells, serializar, ROUTE_CELLS_PATH } from '../generateRouteCells';

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
};

describe('route-cells.json (inventário das irmãs da Maria)', () => {
  const commitado = JSON.parse(fs.readFileSync(ROUTE_CELLS_PATH, 'utf8')) as {
    routes: Array<{ method: string; path: string; cell: string; bloco?: string }>;
  };
  const nome = (r: { method: string; path: string; bloco?: string }) =>
    `${r.method} ${r.path}${r.bloco ? `#${r.bloco}` : ''}`;

  it('tem exatamente as 9 entradas do mapa, cada uma com a célula esperada', () => {
    expect(commitado.routes).toHaveLength(9);
    expect(Object.fromEntries(commitado.routes.map((r) => [nome(r), r.cell]))).toEqual(ESPERADO);
  });

  it('é idêntico ao que a varredura produz agora (regenerar em memória)', async () => {
    const agora = serializar(await gerarRouteCells());
    expect(fs.readFileSync(ROUTE_CELLS_PATH, 'utf8')).toBe(agora);
  });
});
