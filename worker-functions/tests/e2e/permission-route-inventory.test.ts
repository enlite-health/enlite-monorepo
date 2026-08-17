/**
 * O ORÁCULO COMPLETO do deny-when-undeclared (task 3.4, spec
 * permission-enforcement: "rota nova sem declaração → o teste de rotas falha
 * listando a rota").
 *
 * Por que aqui e não num teste unitário: `src/index.ts` monta a app com efeito
 * colateral (abre pools, chama `listen`), então nada consegue importá-lo para
 * varrer o router. A varredura VERDADEIRA só existe com o app de pé — e é
 * exatamente ela que este arquivo lê, pelo inventário publicado em
 * `/.well-known/permissions/routes` do container do e2e.
 *
 * Cobertura por camada, para ninguém confiar demais em uma só:
 *   · `adminUsersRoutes.test.ts` (unit)  — a família declarada, rápido, no CI;
 *   · ESTE (e2e)                          — as 226 rotas do app inteiro;
 *   · `denyUndeclaredRoutes.test.ts`      — o comportamento do guard.
 */

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

interface InventarioRota {
  method: string;
  path: string;
  cell: string | null;
  status: string;
}

interface Inventario {
  totalRoutes: number;
  governedRoutes: InventarioRota[];
  undeclared: string[];
}

async function buscarInventario(headers: Record<string, string>): Promise<Response> {
  return fetch(`${BASE_URL}/.well-known/permissions/routes`, { headers });
}

describe('inventário de rotas governadas (app real de pé)', () => {
  let inventario: Inventario;

  beforeAll(async () => {
    const res = await buscarInventario({ 'X-Internal-Secret': INTERNAL_SECRET });
    expect(res.status).toBe(200);
    inventario = (await res.json()) as Inventario;
  });

  it('exige credencial de serviço (lex C14 — a lista conta topologia)', async () => {
    const semSegredo = await buscarInventario({});
    expect(semSegredo.status).toBe(403);
  });

  it('NENHUMA rota administrativa ficou sem declaração fora das listas conhecidas', () => {
    // Se este teste falhar, a mensagem já traz o que fazer: ou a rota nova
    // declara célula (`perm.require(...)`), ou entra em EXEMPT_ROUTES com
    // justificativa de produto.
    expect(inventario.undeclared).toEqual([]);
  });

  it('a família admin.users está declarada — a primeira virada (task 3.5)', () => {
    const declaradas = inventario.governedRoutes.filter((r) => r.status === 'declared');
    expect(declaradas.map((r) => `${r.method} ${r.path} → ${r.cell}`).sort()).toEqual([
      'DELETE /api/admin/users/:id → user_management:delete',
      'DELETE /api/admin/users/by-email → user_management:delete',
      'GET /api/admin/users → user_management:read',
      'PATCH /api/admin/users/:id/role → permission_management:write',
      'POST /api/admin/users → user_management:write',
      'POST /api/admin/users/:id/reset-password → user_management:write',
    ]);
  });

  it('as isentas são as três da D116, e nenhuma a mais', () => {
    const isentas = inventario.governedRoutes.filter((r) => r.status === 'exempt');
    expect(isentas.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/admin/auth/profile',
      'POST /api/admin/auth/telemetry',
      'POST /api/admin/setup',
    ]);
  });

  it('a lista de PENDENTES não tem entrada morta — rota que sumiu tem que sair da lista', async () => {
    const { PENDING_DECLARATIONS } = await import('@modules/identity');
    const vivasPendentes = new Set(
      inventario.governedRoutes.filter((r) => r.status === 'pending').map((r) => `${r.method} ${r.path}`),
    );
    const mortas = [...PENDING_DECLARATIONS].filter((chave) => !vivasPendentes.has(chave));
    expect(mortas).toEqual([]);
  });

  it('a dívida de rollout só encolhe — o número aqui desce a cada família da task 3.5', () => {
    const pendentes = inventario.governedRoutes.filter((r) => r.status === 'pending');
    expect(pendentes.length).toBeLessThanOrEqual(141);
  });
});
