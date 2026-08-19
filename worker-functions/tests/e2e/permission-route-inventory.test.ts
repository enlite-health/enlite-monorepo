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
 *   · `admin<Familia>Routes.test.ts` (unit) — a família declarada, rápido, no CI;
 *   · ESTE (e2e)                            — as 226 rotas do app inteiro;
 *   · `denyUndeclaredRoutes.test.ts`        — o comportamento do guard.
 *
 * ⚠️ ARMADILHA DE AMBIENTE LOCAL (medida em 19/08/2026, 2ª família da task 3.5):
 * como este arquivo lê o app pela REDE, ele reflete o BINÁRIO DO CONTAINER, não o
 * código da sua árvore — e `npm run test:e2e:reset` **não passa `--build`**, então
 * o compose sobe a imagem em CACHE. Declarei 21 rotas novas, rodei a suíte e ela
 * ficou VERDE lendo o app antigo, que só conhecia `admin.users`. No CI isso não
 * acontece (runner limpo, sem cache, build do código do PR) — ou seja, o falso
 * verde é local e vira vermelho no CI. Antes de confiar neste arquivo na sua
 * máquina, reconstrua:
 *   docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build api
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

  // A lista CRESCE a cada família da task 3.5, e é exaustiva de propósito: uma
  // célula trocada por engano numa refatoração aparece aqui como diff de linha,
  // não como "um número mudou".
  it('as famílias já viradas estão declaradas, rota a rota, com a célula certa', () => {
    const declaradas = inventario.governedRoutes.filter((r) => r.status === 'declared');
    expect(declaradas.map((r) => `${r.method} ${r.path} → ${r.cell}`).sort()).toEqual(
      [
        // ── admin.users (6) — a 1ª família virada
        'DELETE /api/admin/users/:id → user_management:delete',
        'DELETE /api/admin/users/by-email → user_management:delete',
        'GET /api/admin/users → user_management:read',
        'PATCH /api/admin/users/:id/role → permission_management:write',
        'POST /api/admin/users → user_management:write',
        'POST /api/admin/users/:id/reset-password → user_management:write',
        // ── admin.patients (21) — a 2ª
        'DELETE /api/admin/patient-chat-roles/:code → patient:write',
        'DELETE /api/admin/patients/:id → patient:delete',
        'GET /api/admin/chat-groups → messaging:read',
        'GET /api/admin/patient-chat-roles → patient:read',
        'GET /api/admin/patients → patient:read',
        'GET /api/admin/patients/:id → patient:read',
        'GET /api/admin/patients/:id/chat-candidates → messaging:read',
        'GET /api/admin/patients/:id/vacancies → vacancy:read',
        'GET /api/admin/patients/:patientId/addresses → patient:read',
        'GET /api/admin/patients/chat-map → patient:read',
        'GET /api/admin/patients/funnel → patient:read',
        'GET /api/admin/patients/stats → patient:read',
        'PATCH /api/admin/patient-chat-roles/:code → patient:write',
        'PATCH /api/admin/patients/:id/:section → patient:write',
        'PATCH /api/admin/patients/:id/test-flag → patient:write',
        'POST /api/admin/patient-chat-roles → patient:write',
        'POST /api/admin/patients → patient:write',
        'POST /api/admin/patients/:id/activate → patient:write',
        'POST /api/admin/patients/:patientId/addresses → patient:write',
        'PUT /api/admin/patients/:id/chat-ids → patient:write',
        'PUT /api/admin/patients/:id/status → patient:write',
      ].sort(),
    );
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
    // Teto: 141 depois de `admin.users`, 120 depois de `admin.patients`. Cada
    // família nova baixa este número no MESMO PR em que declara.
    expect(pendentes.length).toBeLessThanOrEqual(120);
  });
});
