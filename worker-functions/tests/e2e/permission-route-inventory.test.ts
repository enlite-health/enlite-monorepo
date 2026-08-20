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
        // ── admin.workers (31) — a 3ª, espalhada em 4 arquivos
        'DELETE /api/admin/worker-tags/:id → worker:write',
        'DELETE /api/admin/workers/:id/additional-documents/:docId → worker_document:delete',
        'DELETE /api/admin/workers/:id/documents/:type → worker_document:delete',
        'DELETE /api/admin/workers/:id/documents/:type/validate → worker_document:validate',
        'DELETE /api/admin/workers/:id/tags/:tagId → worker:write',
        'GET /api/admin/worker-tags → worker:read',
        'GET /api/admin/workers → worker:read',
        'GET /api/admin/workers/:id → worker_pii:read',
        'GET /api/admin/workers/:id/additional-documents → worker_document:read',
        'GET /api/admin/workers/:id/available-vacancies → vacancy:read',
        'GET /api/admin/workers/:id/current-interview → interview:read',
        'GET /api/admin/workers/:id/timeline → worker:read',
        'GET /api/admin/workers/by-phone → worker_pii:read',
        'GET /api/admin/workers/case-options → worker:read',
        'GET /api/admin/workers/export → worker:export',
        'GET /api/admin/workers/filter-options → worker:read',
        'GET /api/admin/workers/stats → worker:read',
        'PATCH /api/admin/worker-tags/:id → worker:write',
        'PATCH /api/admin/workers/:id/profile → worker:write',
        'PATCH /api/admin/workers/:id/test-flag → worker:write',
        'POST /api/admin/worker-tags → worker:write',
        'POST /api/admin/workers/:id/additional-documents → worker_document:write',
        'POST /api/admin/workers/:id/additional-documents/upload-url → worker_document:write',
        'POST /api/admin/workers/:id/documents/:type/validate → worker_document:validate',
        'POST /api/admin/workers/:id/documents/ingest-from-url → worker_document:write',
        'POST /api/admin/workers/:id/documents/save → worker_document:write',
        'POST /api/admin/workers/:id/documents/upload-url → worker_document:write',
        'POST /api/admin/workers/:id/documents/view-url → worker_document:read',
        'POST /api/admin/workers/:id/tags/:tagId → worker:write',
        'POST /api/admin/workers/sync-talentum → talentum:write',
        'PUT /api/admin/workers/:id/service-area → worker:write',
        // ── admin.vacancies (45) — a 4ª e maior, um arquivo só
        'DELETE /api/admin/interview-slots/:slotId → interview:delete',
        'DELETE /api/admin/vacancies/:id → vacancy:delete',
        'DELETE /api/admin/vacancies/:id/publish-talentum → talentum:write',
        'DELETE /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes/:noteId → funnel:write',
        'GET /api/admin/dashboard/alerts → dashboard:read',
        'GET /api/admin/dashboard/conversion-by-channel → dashboard:read',
        'GET /api/admin/dashboard/coordinator-capacity → dashboard:read',
        'GET /api/admin/vacancies → vacancy:read',
        'GET /api/admin/vacancies/:id → vacancy:read',
        'GET /api/admin/vacancies/:id/funnel → funnel:read',
        'GET /api/admin/vacancies/:id/funnel-table → funnel:read',
        'GET /api/admin/vacancies/:id/interview-slots → interview:read',
        'GET /api/admin/vacancies/:id/match-results → match:read',
        'GET /api/admin/vacancies/:id/prescreening-config → prescreening:read',
        'GET /api/admin/vacancies/:id/social-links-stats → vacancy:read',
        'GET /api/admin/vacancies/:id/talentum-status → talentum:read',
        'GET /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes → funnel:read',
        'GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status → messaging:read',
        'GET /api/admin/vacancies/by-address → vacancy:read',
        'GET /api/admin/vacancies/cases-for-select → vacancy:read',
        'GET /api/admin/vacancies/filter-options → vacancy:read',
        'GET /api/admin/vacancies/in-progress → vacancy:read',
        'GET /api/admin/vacancies/next-vacancy-number → vacancy:read',
        'GET /api/admin/vacancies/pending-address-review → vacancy:read',
        'GET /api/admin/vacancies/stats → vacancy:read',
        'POST /api/admin/interview-slots/:slotId/book → interview:write',
        'POST /api/admin/vacancies → vacancy:write',
        'POST /api/admin/vacancies/:id/generate-ai-content → vacancy:write',
        'POST /api/admin/vacancies/:id/generate-talentum-description → talentum:write',
        'POST /api/admin/vacancies/:id/interview-slots → interview:write',
        'POST /api/admin/vacancies/:id/match → match:execute',
        'POST /api/admin/vacancies/:id/prescreening-config → prescreening:write',
        'POST /api/admin/vacancies/:id/publish-talentum → talentum:write',
        'POST /api/admin/vacancies/:id/resolve-address-review → vacancy:write',
        'POST /api/admin/vacancies/:id/social-links → vacancy:write',
        'POST /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes → funnel:write',
        'POST /api/admin/vacancies/blocked-applications/:blockedId/reject → funnel:write',
        'POST /api/admin/vacancies/blocked-applications/:blockedId/restore → funnel:write',
        'POST /api/admin/vacancies/meet-links/lookup → vacancy:read',
        'POST /api/admin/vacancies/sync-talentum → talentum:write',
        'PUT /api/admin/encuadres/:id/move → funnel:write',
        'PUT /api/admin/encuadres/:id/result → funnel:write',
        'PUT /api/admin/vacancies/:id → vacancy:write',
        'PUT /api/admin/vacancies/:id/meet-links → vacancy:write',
        'PUT /api/admin/vacancies/:id/talentum-description → talentum:write',
        // ── admin.analytics (15) + admin.recruitment (11) — a 5ª e a 6ª
        'GET /analytics/dashboard/cases/:caseNumber → dashboard:read',
        'GET /analytics/dashboard/global → dashboard:read',
        'GET /analytics/dashboard/management → dashboard:read',
        'GET /analytics/dashboard/reemplazos → dashboard:read',
        'GET /analytics/dashboard/zone-analytics → dashboard:read',
        'GET /analytics/dashboard/zones → dashboard:read',
        'GET /analytics/dedup/candidates → dedup:read',
        'GET /analytics/vacancies → analytics:read',
        'GET /analytics/vacancies/:id → analytics:read',
        'GET /analytics/vacancies/:id/incomplete-registrations → analytics:read',
        'GET /analytics/vacancies/case/:caseNumber → analytics:read',
        'GET /analytics/workers → analytics:read',
        'GET /analytics/workers/:workerId/vacancies → analytics:read',
        'GET /analytics/workers/missing-documents → analytics:read',
        'GET /api/admin/recruitment/blocked-attempts → recruitment:read',
        'GET /api/admin/recruitment/case/:caseNumber → recruitment:read',
        'GET /api/admin/recruitment/clickup-cases → recruitment:read',
        'GET /api/admin/recruitment/encuadres → match:read',
        'GET /api/admin/recruitment/global-metrics → recruitment:read',
        'GET /api/admin/recruitment/health → messaging:read',
        'GET /api/admin/recruitment/progreso → recruitment:read',
        'GET /api/admin/recruitment/publications → recruitment:read',
        'GET /api/admin/recruitment/talentum-workers → talentum:read',
        'GET /api/admin/recruitment/zones → recruitment:read',
        'POST /analytics/dedup/run → dedup:execute',
        'POST /api/admin/recruitment/calculate-reemplazos → recruitment:write',
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
    // Teto: 141 depois de `admin.users`, 120 depois de `admin.patients`, 89
    // depois de `admin.workers`. Cada família nova baixa este número no MESMO
    // PR em que declara.
    //
    // ⚠️ ÚNICA VEZ em que este teto SUBIU: 89 → 99 (19/08). Não foi dívida
    // acrescentada — foi a MEDIÇÃO que ficou mais larga. As 10 rotas de staff do
    // `workerEncuadreRoutes` sempre estiveram sem declaração; elas viviam fora
    // de `GOVERNED_PREFIXES` e por isso não apareciam aqui. Ao entrarem no
    // perímetro por nome (`GOVERNED_ROUTES`), passaram a ser contadas. Número
    // maior e verdadeiro vale mais que número menor e cego. Depois de
    // `admin.vacancies` (45): 54. Depois de `analytics`+`recruitment` (26): 28.
    expect(pendentes.length).toBeLessThanOrEqual(28);
  });

  it('as 10 rotas de encuadre fora do prefixo estão DENTRO do perímetro (não `not_governed`)', () => {
    // O que este caso protege: elas entraram por NOME. Se alguém remover uma
    // linha de `GOVERNED_ROUTES`, a rota volta a sumir do inventário em
    // silêncio — e sumir é exatamente o modo de falha que criou o achado.
    const encuadre = [
      'GET /api/workers/status-dashboard',
      'GET /api/workers/by-status/:status',
      'PUT /api/workers/:id/status',
      'PUT /api/workers/:id/occupation',
      'GET /api/workers/docs-expiring',
      'PUT /api/workers/:id/doc-expiry',
      'GET /api/workers/:id/encuadres',
      'GET /api/workers/:id/cases',
      'GET /api/cases/:caseNumber/encuadres',
      'GET /api/cases/:caseNumber/workers',
    ];
    const vistas = new Map(
      inventario.governedRoutes.map((r) => [`${r.method} ${r.path}`, r.status]),
    );
    expect(encuadre.map((chave) => `${chave} → ${vistas.get(chave) ?? 'FORA DO INVENTÁRIO'}`)).toEqual(
      encuadre.map((chave) => `${chave} → pending`),
    );
  });

  it('as rotas do PRESTADOR seguem FORA do perímetro — o que a lista nomeada preserva', () => {
    // A alternativa descartada (ampliar `GOVERNED_PREFIXES` para `/api/workers/`)
    // teria trazido estas para dentro, cada uma precisando de EXEMPT. Uma
    // esquecida = app do candidato em 403 no dia da virada.
    const doPrestador = inventario.governedRoutes.filter((r) => r.path.startsWith('/api/workers/me'));
    expect(doPrestador).toEqual([]);
  });
});
