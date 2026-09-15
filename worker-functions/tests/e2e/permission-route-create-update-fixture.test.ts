/**
 * tests/e2e/permission-route-create-update-fixture.test.ts
 *
 * PR-8b, rodada A2 (8b.1/8b.4) — varre o inventário REAL de rotas
 * (`/.well-known/permissions/routes`, o mesmo oráculo do
 * `permission-route-inventory.test.ts`) e confere, rota a rota, contra a
 * fixture nominal `tests/fixtures/pr8b-rotas-create-update.ts` (gerada de
 * `specs/018-planning-0909-ficha-admissao/pr8b-mapa-rotas.tsv`).
 *
 * O inventário carimba UMA célula por rota — a do PRIMEIRO guard no array de
 * middlewares (`cellOfRoute`, `scanExpressRouter.ts`). Para as 4 rotas que
 * exigem `create` E `update` (guards encadeados no MESMO array da rota,
 * `contracts/permissions-split.md` + `pr8b-mapa-rotas.tsv`), este teste só
 * confere a AÇÃO PRIMÁRIA (a primeira da fixture) pelo inventário — o segundo
 * guard é provado por fora, no teste de unidade
 * `tests/unit/.../pr8b-ambiguous-routes.test.ts`, que instrumenta os DOIS
 * guards diretamente no router (sem precisar do app inteiro de pé).
 *
 * Duas falhas possíveis, e cada uma aponta pro conserto certo:
 *   1. rota da fixture com célula diferente da esperada → a ROTA está errada
 *      (voltou a `write`, ou foi para a ação trocada);
 *   2. rota REAL fora da fixture ainda declarando `:write` (exceto as 9 de
 *      `permission_management`, que ficam `write` por contrato) → sobrou
 *      write que devia ter sido splitado, ou a fixture está incompleta.
 */

import { PR8B_ROTAS_CREATE_UPDATE } from '../fixtures/pr8b-rotas-create-update';

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

/** As 9 rotas de `permission_management` — ficam `write` por contrato (linha 11). */
const PERMISSION_MANAGEMENT_WRITE_ROUTES = new Set([
  'POST /api/admin/permission-groups',
  'PATCH /api/admin/permission-groups/:id',
  'DELETE /api/admin/permission-groups/:id',
  'PUT /api/admin/permission-groups/:id/permissions',
  'POST /api/admin/permission-groups/:id/countries',
  'DELETE /api/admin/permission-groups/:id/countries/:country',
  'POST /api/admin/permission-groups/:id/members',
  'DELETE /api/admin/permission-groups/:id/members',
  'PUT /api/admin/country-features/:country/:featureKey',
]);

interface InventarioRota {
  method: string;
  path: string;
  cell: string | null;
  status: string;
}

interface Inventario {
  totalRoutes: number;
  governedRoutes: InventarioRota[];
  declaredCells: string[];
  undeclared: string[];
}

async function buscarInventario(): Promise<Inventario> {
  const res = await fetch(`${BASE_URL}/.well-known/permissions/routes`, {
    headers: { 'X-Internal-Secret': INTERNAL_SECRET },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Inventario;
}

describe('PR-8b (8b.1/8b.4) — fixture nominal create/update contra o inventário real', () => {
  let porChave: Map<string, InventarioRota>;

  beforeAll(async () => {
    const inventario = await buscarInventario();
    porChave = new Map(inventario.governedRoutes.map((r) => [`${r.method} ${r.path}`, r]));
  });

  it('cada rota da fixture (99) está no inventário e declara a AÇÃO PRIMÁRIA certa', () => {
    const divergentes = PR8B_ROTAS_CREATE_UPDATE.map((rota) => {
      const chave = `${rota.method} ${rota.path}`;
      const encontrada = porChave.get(chave);
      const acaoEsperada = rota.actions[0];
      const celulaObservada = encontrada?.cell ?? null;
      const acaoObservada = celulaObservada?.split(':')[1] ?? null;
      const ok = encontrada !== undefined && acaoObservada === acaoEsperada;
      return ok ? null : `${chave} → esperado ação '${acaoEsperada}' (fixture: ${rota.source}), observado '${celulaObservada ?? 'FORA DO INVENTÁRIO'}'`;
    }).filter((linha): linha is string => linha !== null);

    expect(divergentes).toEqual([]);
  });

  it('NENHUMA rota fora de permission_management ainda declara `write`', () => {
    const comWrite = Array.from(porChave.values())
      .filter((r) => r.cell?.endsWith(':write'))
      .map((r) => `${r.method} ${r.path} → ${r.cell}`)
      .filter((chave) => !PERMISSION_MANAGEMENT_WRITE_ROUTES.has(chave.split(' → ')[0]));

    expect(comWrite).toEqual([]);
  });

  it('as 9 rotas de permission_management CONTINUAM `write` (contrato, linha 11)', () => {
    const observadas = Array.from(PERMISSION_MANAGEMENT_WRITE_ROUTES).map((chave) => {
      const rota = porChave.get(chave);
      return `${chave} → ${rota?.cell ?? 'FORA DO INVENTÁRIO'}`;
    });
    expect(observadas).toEqual(
      Array.from(PERMISSION_MANAGEMENT_WRITE_ROUTES).map((chave) => `${chave} → permission_management:write`),
    );
  });
});
