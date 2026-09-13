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
  /** A varredura INTEIRA — a mesma fonte que o sync do catálogo consome. */
  declaredCells: string[];
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
        'POST /api/admin/users → user_management:write',
        'POST /api/admin/users/:id/reset-password → user_management:write',
        // ── admin.permissions (7) — a leitura do painel (F3) + o POST de
        // leitura da C6. São estas linhas que mantêm `permission_management:read`
        // viva no catálogo: sem nenhuma delas o sync descontinua a célula e
        // `iam.query_audit` responde 42501 para todos. Ordenadas como o `.sort()`
        // acima devolve.
        'GET /api/admin/country-features → permission_management:read',
        'GET /api/admin/permission-audit → permission_management:read',
        'GET /api/admin/permission-groups → permission_management:read',
        'GET /api/admin/permission-groups/:id → permission_management:read',
        'GET /api/admin/permission-groups/:id/members → permission_management:read',
        'GET /api/admin/permissions/catalog → permission_management:read',
        // POST na FORMA (a C6 tira `userId` da query), `:read` na REGRA — a
        // exceção declarada à convenção "POST é sempre `:write`" desta família.
        'POST /api/admin/permission-audit/query → permission_management:read',
        // ── admin.permissions, ESCRITA (9) — a F4. Todas `:write`, e o portão
        // real delas é o `SECURITY DEFINER` da mig 279, não este `perm.require`.
        'DELETE /api/admin/permission-groups/:id → permission_management:write',
        'DELETE /api/admin/permission-groups/:id/countries/:country → permission_management:write',
        'DELETE /api/admin/permission-groups/:id/members → permission_management:write',
        'PATCH /api/admin/permission-groups/:id → permission_management:write',
        'POST /api/admin/permission-groups → permission_management:write',
        'POST /api/admin/permission-groups/:id/countries → permission_management:write',
        'POST /api/admin/permission-groups/:id/members → permission_management:write',
        'PUT /api/admin/country-features/:country/:featureKey → permission_management:write',
        'PUT /api/admin/permission-groups/:id/permissions → permission_management:write',
        // ── admin.patients (24) — a 2ª
        'DELETE /api/admin/patient-chat-roles/:code → patient:write',
        'DELETE /api/admin/patients/:id → patient:delete',
        // Marca de emergência (spec 018, PR-2, D-A; contracts/support-network.md).
        'DELETE /api/admin/patients/:id/emergency-contact → patient_family:write',
        'GET /api/admin/chat-groups → messaging:read',
        'GET /api/admin/patient-chat-roles → patient:read',
        'GET /api/admin/patients → patient:read',
        'GET /api/admin/patients/:id → patient:read',
        'GET /api/admin/patients/:id/chat-candidates → messaging:read',
        'GET /api/admin/patients/:id/vacancies → vacancy:read',
        'GET /api/admin/patients/:patientId/addresses → patient_address:read',
        'GET /api/admin/patients/chat-map → patient:read',
        'GET /api/admin/patients/funnel → patient:read',
        'GET /api/admin/patients/stats → patient:read',
        'PATCH /api/admin/patient-chat-roles/:code → patient:write',
        // D286: o PATCH dinâmico por seção virou rotas explícitas, uma por container.
        // `support-network` SAIU (spec 018, PR-1, SUP-37) — a rota é 410, isenta em
        // EXEMPT_ROUTES (não aparece aqui, que é só o que tem `status: 'declared'`).
        'PATCH /api/admin/patients/:id/clinical → patient_clinical:write',
        'PATCH /api/admin/patients/:id/coverage → patient_coverage:write',
        // Escrita por linha (spec 018, PR-1, ADR-1; contracts/support-network.md).
        'PATCH /api/admin/patients/:id/coverage-emergency-contacts/:cid → patient_coverage:write',
        // Contatos externos sem vínculo familiar (spec 018, PR-2, `lex` #4).
        'PATCH /api/admin/patients/:id/external-contacts/:xid → patient_family:write',
        'PATCH /api/admin/patients/:id/general → patient_identity:write',
        // Escrita por linha (spec 018, PR-5, US-11) — célula NOVA `patient_care_team:write`.
        'PATCH /api/admin/patients/:id/professionals/:pid → patient_care_team:write',
        'PATCH /api/admin/patients/:id/responsibles/:rid → patient_family:write',
        'PATCH /api/admin/patients/:id/service → patient_services:write',
        'PATCH /api/admin/patients/:id/test-flag → patient:write',
        'POST /api/admin/patient-chat-roles → patient:write',
        'POST /api/admin/patients → patient:write',
        // POST /:id/activate SAIU (spec 018, PR-6, ADR-5) — a rota é 410, isenta em EXEMPT_ROUTES
        // (mesmo molde do support-network acima).
        'POST /api/admin/patients/:id/contracted-services/:sid/activate-recruitment → patient_services:write',
        'POST /api/admin/patients/:id/coverage-emergency-contacts → patient_coverage:write',
        'POST /api/admin/patients/:id/coverage-emergency-contacts/:cid/deactivate → patient_coverage:write',
        'POST /api/admin/patients/:id/external-contacts → patient_family:write',
        'POST /api/admin/patients/:id/external-contacts/:xid/deactivate → patient_family:write',
        'POST /api/admin/patients/:id/professionals → patient_care_team:write',
        'POST /api/admin/patients/:id/professionals/:pid/deactivate → patient_care_team:write',
        'POST /api/admin/patients/:id/responsibles → patient_family:write',
        'POST /api/admin/patients/:id/responsibles/:rid/deactivate → patient_family:write',
        'POST /api/admin/patients/:patientId/addresses → patient_address:write',
        'PUT /api/admin/patients/:id/chat-ids → patient_chat:write',
        'PUT /api/admin/patients/:id/emergency-contact → patient_family:write',
        'PUT /api/admin/patients/:id/status → patient:write',
        // ── admin.workers (31) — a 3ª, espalhada em 4 arquivos
        'DELETE /api/admin/worker-tags/:id → worker:write',
        'DELETE /api/admin/workers/:id/additional-documents/:docId → worker_document:delete',
        'DELETE /api/admin/workers/:id/documents/:type → worker_document:delete',
        'DELETE /api/admin/workers/:id/documents/:type/validate → worker_document:validate',
        'DELETE /api/admin/workers/:id/tags/:tagId → worker:write',
        'GET /api/admin/worker-tags → worker:read',
        'GET /api/admin/workers → worker:read',
        'GET /api/admin/workers/:id → worker:read',
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
        'GET /analytics/dashboard/zone-analytics → dashboard_zones:read',
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
        // ── A4: admin.messaging (7) + admin.integrations (1) + admin.test_fixtures (1)
        'POST /api/admin/messaging/whatsapp/vacancy-match → messaging:send',
        'POST /api/admin/messaging/whatsapp/direct → messaging:send',
        'GET /api/admin/messaging/templates → messaging:read',
        'POST /api/admin/messaging/templates → messaging:write',
        'PUT /api/admin/messaging/templates/:slug → messaging:write',
        'DELETE /api/admin/messaging/templates/:slug → messaging:write',
        'POST /api/admin/messaging/bulk-dispatch-incomplete → messaging:send',
        'POST /api/admin/integrations/anacare/backfill → integration:execute',
        'POST /api/admin/test-fixtures/cleanup → test_fixtures:execute',
        // ── A5: admin.dedup (9) — a última de propósito
        'GET /api/admin/dedup/groups → dedup:read',
        'GET /api/admin/dedup/groups/:phoneNormalized → dedup:read',
        'POST /api/admin/dedup/merge → dedup:execute',
        'POST /api/admin/dedup/dismiss → dedup:execute',
        'POST /api/admin/dedup/merges/:auditId/undo → dedup:execute',
        'GET /api/admin/dedup/history → dedup:read',
        'GET /api/admin/dedup/imported-groups → dedup:read',
        'GET /api/admin/dedup/candidates → dedup:read',
        'POST /api/admin/dedup/manual-group → dedup:execute',
        // ── A6: admin.encuadre (10) — as que o perímetro não alcançava; ZERAM a dívida
        'GET /api/workers/status-dashboard → worker:read',
        'GET /api/workers/by-status/:status → worker:read',
        'PUT /api/workers/:id/status → worker:write',
        'PUT /api/workers/:id/occupation → worker:write',
        'GET /api/workers/docs-expiring → worker_document:read',
        'PUT /api/workers/:id/doc-expiry → worker_document:write',
        'GET /api/workers/:id/encuadres → match:read',
        'GET /api/workers/:id/cases → match:read',
        'GET /api/cases/:caseNumber/encuadres → match:read',
        'GET /api/cases/:caseNumber/workers → match:read',
        // ── sync main→stage (06/09/2026): as 31 rotas que o main trouxe (specs 011-016, mensageria, mapa),
        //    sob a célula GROSSA; o fatiamento por container é a D286.
        'DELETE /api/admin/template-drafts/:id → messaging:write',
        'GET /api/admin/catalogs/insurance-providers → patient_coverage:read',
        'GET /api/admin/funnel-stage-messages → messaging:read',
        'GET /api/admin/patients/:id/contracted-services → patient_services:read',
        'GET /api/admin/patients/:id/diagnoses → patient_clinical:read',
        'GET /api/admin/patients/:id/status-history → patient:read',
        'GET /api/admin/presentation-invite/last → messaging:read',
        'GET /api/admin/presentation-invite/settings → messaging:read',
        'GET /api/admin/presentation-invite/stats → messaging:read',
        'GET /api/admin/template-catalog → messaging:read',
        'GET /api/admin/template-drafts → messaging:read',
        'GET /api/admin/terminology/search → patient_clinical:read',
        'PATCH /api/admin/patients/:id/contracted-services/:sid → patient_services:write',
        'PATCH /api/admin/patients/:id/contracted-services/:sid/providers/:pid → patient_services:write',
        'PATCH /api/admin/patients/:id/diagnoses/:did → patient_clinical:write',
        'PATCH /api/admin/patients/:patientId/addresses/:addressId → patient_address:write',
        'POST /api/admin/catalogs/insurance-providers → patient:write',
        'POST /api/admin/map/corridor → patient_address:read',
        'POST /api/admin/patients/:id/contracted-services → patient_services:write',
        'POST /api/admin/patients/:id/contracted-services/:sid/providers → patient_services:write',
        'POST /api/admin/patients/:id/diagnoses → patient_clinical:write',
        'POST /api/admin/patients/map → patient_address:read',
        'POST /api/admin/template-drafts → messaging:write',
        'POST /api/admin/template-drafts/:id/duplicate → messaging:write',
        'POST /api/admin/template-drafts/:id/submit → messaging:write',
        'POST /api/admin/template-drafts/validar → messaging:write',
        'POST /api/admin/workers/:workerId/presentation-invite → messaging:send',
        'POST /api/admin/workers/map → worker_address:read',
        'PUT /api/admin/funnel-stage-messages/:stage → messaging:write',
        'PUT /api/admin/presentation-invite/settings → messaging:write',
        'PUT /api/admin/template-drafts/:id → messaging:write',
        // ── spec 017 (08/09/2026): projeto terapêutico versionado + 2 catálogos, família admin.patients (D299.3; tipo de patologia deriva do CID-11)
        'GET /api/admin/patients/:id/therapeutic-projects → patient_therapeutic_project:read',
        'GET /api/admin/patients/:id/therapeutic-projects/:vid → patient_therapeutic_project:read',
        'POST /api/admin/patients/:id/therapeutic-projects → patient_therapeutic_project:write',
        'POST /api/admin/patients/:id/therapeutic-projects/:vid/annul → patient_therapeutic_project:write',
        'GET /api/admin/therapeutic-catalogs/specific-objectives → catalog_therapeutic_objectives:read',
        'POST /api/admin/therapeutic-catalogs/specific-objectives → catalog_therapeutic_objectives:write',
        'PATCH /api/admin/therapeutic-catalogs/specific-objectives/:itemId → catalog_therapeutic_objectives:write',
        'GET /api/admin/therapeutic-catalogs/activities → catalog_therapeutic_activities:read',
        'POST /api/admin/therapeutic-catalogs/activities → catalog_therapeutic_activities:write',
        'PATCH /api/admin/therapeutic-catalogs/activities/:itemId → catalog_therapeutic_activities:write',
        // US-17 (spec 018, PR-7, migration 430) — catálogo dos segmentos da Ana Care, mesmo molde.
        'GET /api/admin/therapeutic-catalogs/segments → catalog_therapeutic_segments:read',
        'POST /api/admin/therapeutic-catalogs/segments → catalog_therapeutic_segments:write',
        'PATCH /api/admin/therapeutic-catalogs/segments/:itemId → catalog_therapeutic_segments:write',
      ].sort(),
    );
  });

  it('as isentas são as SEIS decididas, e nenhuma a mais', () => {
    // Eram três (D116). `GET /v1/me/authz` entrou na F3: ela é `self` como as
    // outras, mas mora em `/v1/`, fora dos `GOVERNED_PREFIXES` — nascia
    // `not_governed`, isto é, isenta SEM linha, invisível a este teste. Foi o
    // BLOCKER-1 do gate `revisao-pr`: a isenção tem de ser revisável, e é esta
    // linha que a torna. Desde 28/08 ela entra aqui pela MARCA da montagem
    // (`exemptHandler` em `meAuthzRoute.ts`), não por lista: tirar a marca faz
    // a rota sumir deste inventário e este caso acusa.
    // `PATCH /patients/:id/support-network` entrou no PR-1 (spec 018, ADR-1,
    // SUP-37): a rota da lista inteira virou 410 e não decide mais nada sobre
    // o dado — não há célula que faça sentido pedir para uma rota que só recusa.
    // `POST /patients/:id/activate` entrou no PR-6 (spec 018, ADR-5): mesmo
    // molde do support-network — a rota virou 410 puro (ACTIVATION_SPLIT),
    // substituída por `POST .../contracted-services/:sid/activate-recruitment`
    // (declarada com `patient_services:write`, não isenta).
    const isentas = inventario.governedRoutes.filter((r) => r.status === 'exempt');
    expect(isentas.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/admin/auth/profile',
      'GET /v1/me/authz',
      'PATCH /api/admin/patients/:id/support-network',
      'POST /api/admin/auth/telemetry',
      'POST /api/admin/patients/:id/activate',
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

  it('🎉 a dívida de rollout ZEROU — a task 3.5 terminou', () => {
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
    // `admin.vacancies` (45): 54. Depois de `analytics`+`recruitment` (26): 28. Depois do A4 (9): 19. Depois do A5 (9): 10. Depois do A6 (10): **ZERO**.
    // Daqui em diante o teste é de INVARIANTE, não de teto: rota administrativa
    // nova nasce `undeclared` e o e2e acima já a pega. Só com esta lista vazia é
    // que o A7 pode ligar `PERMISSION_CATALOG_SYNC_ENABLED`.
    expect(pendentes).toEqual([]);
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
    // Desde o A6 elas são `declared` (antes eram `pending`). O que este caso
    // protege segue igual: se alguém remover uma linha de `GOVERNED_ROUTES`, a
    // rota some do inventário em silêncio — e sumir é o modo de falha original.
    expect(encuadre.map((chave) => `${chave} → ${vistas.get(chave) ?? 'FORA DO INVENTÁRIO'}`)).toEqual(
      encuadre.map((chave) => `${chave} → declared`),
    );
  });

  /**
   * As CINCO células do seed da 206 que nenhuma rota declara — e que por isso o
   * sync do catálogo (A7) vai descontinuar. O catálogo é DERIVADO do código
   * (D115): célula que nenhuma rota exige é promessa que o sistema não cumpre.
   *
   * ⚠️ Elas NÃO são equivalentes entre si, e a diferença é o que este caso
   * registra:
   *   · `upload:read`, `upload:write` — a D116 já as declarou deprecated;
   *   · `analytics:export`, `worker:delete` — órfãs de verdade, descontinuar de
   *     propósito (decisão do Gabriel, 20/08); ninguém as usa, nem o frontend;
   *   · `permission_management:read` — **NÃO é órfã.** `iam.query_audit`
   *     (mig 280:143) levanta `42501` sem ela, e o painel do grupo 4 (tasks 4.1,
   *     4.8, 4.10) é quem vai declará-la. É por causa dela que o A7 espera a
   *     Fase B: descontinuá-la antes do painel mataria a leitura da trilha de
   *     auditoria para todo mundo, inclusive o Acesso Master.
   *
   * Este caso existe para que a decisão seja REVERSÍVEL COM AVISO: declarar uma
   * rota com qualquer uma delas deixa isto vermelho, e a pessoa descobre que
   * precisa contar com o `'revived'` do sync (o upsert limpa `deprecated_at`).
   *
   * ⚠️ ORÁCULO: a fonte aqui é `declaredCells(scanExpressRouter(app))` — a
   * varredura INTEIRA —, e **não** `inventario.governedRoutes`. O sync consome a
   * varredura inteira, então uma célula declarada em rota FORA do perímetro
   * (`/api/workers/me/*`, `/mcp/v1/*`, webhook) seria revivida no catálogo dos
   * ambientes implantados sem este caso notar. Usar `governedRoutes` aqui
   * derrotaria o próprio propósito do teste.
   */
  it('as 4 células do seed que NENHUMA rota declara — as que o A7 descontinua', () => {
    // `declaredCells` (não `governedRoutes`) é a varredura INTEIRA — a MESMA
    // fonte que o sync consome. Ver o comentário no endpoint.
    // `permission_management:read` SAIU desta lista em 28/08: a F3 (família
    // `admin.permissions`, 6 rotas) passou a declará-la — é o `'revived'` do
    // sync acontecendo, exatamente como o comentário acima previa. Este caso
    // ficou vermelho na base por isso (achado #1 da task 004).
    const declaradas = new Set(inventario.declaredCells);

    expect(
      ['upload:read', 'upload:write', 'analytics:export', 'worker:delete'].filter((celula) => declaradas.has(celula)),
    ).toEqual([]);
  });

  it('as rotas do PRESTADOR seguem FORA do perímetro — o que a lista nomeada preserva', () => {
    // A alternativa descartada (ampliar `GOVERNED_PREFIXES` para `/api/workers/`)
    // teria trazido estas para dentro, cada uma precisando de EXEMPT. Uma
    // esquecida = app do candidato em 403 no dia da virada.
    const doPrestador = inventario.governedRoutes.filter((r) => r.path.startsWith('/api/workers/me'));
    expect(doPrestador).toEqual([]);
  });
});
