/**
 * generateRouteCells.ts — inventário rota -> célula das rotas que as 8 irmãs da Maria
 * (change 081, T034) chamam. Fonte: a varredura de runtime `scanExpressRouter` (a mesma do
 * catálogo de permissões), aplicada aos routers REAIS montados como em `src/index.ts`
 * (`/api/admin` e `/api`) com controllers-dublê. NÃO há segunda varredura por regex.
 *
 * Uso (de worker-functions/):
 *   npx ts-node --transpile-only -r tsconfig-paths/register scripts/generateRouteCells.ts
 * Escreve src/contracts/assistants/route-cells.json. Sem rede, sem banco.
 *
 * O bloco `documents` não é rota própria: a célula `worker_document:read` é aplicada DENTRO do
 * builder (AdminWorkersDetailBuilder.ts:132), não em `perm.require`. Por isso entra com
 * `enforcedIn: "builder"`, derivada da varredura só no que ela sabe (a rota-mãe), e a célula é
 * constante declarada aqui.
 */
import fs from 'fs';
import path from 'path';

export const ROUTE_CELLS_PATH = path.resolve(__dirname, '../src/contracts/assistants/route-cells.json');

export interface RouteCellEntry {
  method: string;
  path: string;
  cell: string;
  irmas: string[];
  enforcedIn: 'perm.require' | 'builder';
  bloco?: string;
}

/** O mapa do design §3 (rotas reais medidas na T021). Chave = `METHOD path`. */
const MAPA: Array<{ method: string; path: string; irmas: string[] }> = [
  { method: 'GET', path: '/api/admin/workers/:id', irmas: ['worker_profile_read'] },
  { method: 'GET', path: '/api/workers/:id/encuadres', irmas: ['worker_applications_read'] },
  { method: 'GET', path: '/api/admin/workers/:id/current-interview', irmas: ['worker_interview_read'] },
  { method: 'GET', path: '/api/admin/workers/:id/available-vacancies', irmas: ['worker_vacancies_read'] },
  { method: 'GET', path: '/api/admin/vacancies/:id', irmas: ['vacancy_details_read'] },
  { method: 'GET', path: '/api/admin/vacancies/:id/interview-slots', irmas: ['interview_slots_read'] },
  { method: 'GET', path: '/api/admin/workers', irmas: ['worker_search'] },
  // T064b (D602a): atividade do funil por recrutadora e semana, célula só do Acesso Master.
  { method: 'GET', path: '/api/admin/recruitment/activity-per-person', irmas: ['recruitment_activity_per_person'] },
];

const DOCUMENTS = {
  method: 'GET',
  path: '/api/admin/workers/:id',
  bloco: 'documents',
  cell: 'worker_document:read',
  irmas: ['worker_documents_read'],
  enforcedIn: 'builder' as const,
};

const responde = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ m: nome });
const dubleDe = (prefixo: string, metodos: string[]): Record<string, unknown> =>
  Object.fromEntries(metodos.map((m) => [m, responde(`${prefixo}.${m}`)]));

export async function gerarRouteCells(): Promise<RouteCellEntry[]> {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit';
  const express = (await import('express')).default;
  const { scanExpressRouter, cellKey } = await import('@modules/identity/permissions');
  const { authDouble } = await import('@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles');
  const { PermissionMiddleware } = await import('@modules/identity/interfaces/middleware/PermissionMiddleware');
  // PermissionMiddleware REAL (quem carimba a célula), com client/trilha inertes e `env: {}`:
  // mesmo desenho de `permissionsDouble()`, sem depender de `jest` (este script roda fora do jest).
  const nada = () => undefined;
  const permissionsDouble = () =>
    new PermissionMiddleware({
      client: { resolve: nada, can: nada, isFeatureAvailable: nada, featureConfig: nada, invalidate: nada } as never,
      audit: { record: nada } as never,
      env: {},
    });
  const { createAdminWorkerRoutes } = await import('@modules/worker/interfaces/routes/adminWorkerRoutes');
  const { createWorkerContextRoutes } = await import('@modules/matching/interfaces/routes/workerContextRoutes');
  const { createAdminVacanciesRoutes } = await import('@modules/matching/interfaces/routes/adminVacanciesRoutes');
  const { createWorkerEncuadreRoutes } = await import('@modules/matching/interfaces/routes/workerEncuadreRoutes');
  const { createRecruitmentRoutes } = await import('@modules/matching/interfaces/routes/recruitmentRoutes');

  const app = express();
  app.use(
    '/api/admin',
    createAdminWorkerRoutes(
      {
        workers: dubleDe('w', ['getWorkerByPhone', 'exportWorkers', 'getWorkerById', 'listWorkers']),
        aux: dubleDe('aux', ['getWorkerDateStats', 'listCaseOptions', 'getFilterOptions', 'syncTalentumWorkers']),
        testFlag: dubleDe('tf', ['updateTestFlag']),
        profile: dubleDe('p', ['updateProfile']),
        serviceArea: dubleDe('sa', ['updateServiceArea']),
        tags: dubleDe('t', ['list', 'create', 'update', 'delete', 'assign', 'remove']),
        timeline: dubleDe('tl', ['getTimeline']),
        map: dubleDe('m', ['getMapPoints']),
      } as never,
      authDouble(),
      permissionsDouble(),
    ),
  );
  app.use(
    '/api/admin',
    createWorkerContextRoutes(
      dubleDe('ctx', ['currentInterview', 'availableVacancies', 'ingestFromUrl']) as never,
      authDouble(),
      permissionsDouble(),
    ),
  );
  app.use(
    '/api/admin',
    createAdminVacanciesRoutes(
      dubleDe('vac', ['listVacancies', 'getVacanciesStats', 'getNextVacancyNumber', 'getCasesForSelect', 'getVacancyById']) as never,
      dubleDe('crud', ['createVacancy', 'updateVacancy', 'deleteVacancy']) as never,
      dubleDe('talentum', ['publishToTalentum', 'unpublishFromTalentum', 'generateTalentumDescription',
        'updateTalentumDescription', 'generateAIContent', 'syncFromTalentum', 'getPrescreeningConfig',
        'getTalentumStatus', 'savePrescreeningConfig']) as never,
      dubleDe('match', ['getMatchResults', 'triggerMatch', 'updateEncuadreResult']) as never,
      dubleDe('social', ['generateSocialLink', 'getSocialLinksStats']) as never,
      dubleDe('funnel', ['getEncuadreFunnel', 'moveEncuadre', 'rejectBlockedApplication', 'undismissBlockedApplication']) as never,
      dubleDe('dash', ['getCoordinatorCapacity', 'getAlerts', 'getConversionByChannel']) as never,
      dubleDe('slots', ['createSlots', 'getSlots', 'bookSlot', 'cancelSlot']) as never,
      authDouble(),
      permissionsDouble(),
      dubleDe('addr', ['resolveAddressReview']) as never,
      dubleDe('table', ['getEncuadreFunnelTable']) as never,
    ),
  );
  app.use(
    '/api',
    createWorkerEncuadreRoutes(
      dubleDe('enc', ['getStatusDashboard', 'getWorkersByStatus', 'updateWorkerStatus', 'updateOccupation',
        'getDocsExpiringSoon', 'updateDocExpiry', 'getWorkerEncuadres', 'getWorkerCases',
        'getCaseEncuadres', 'getCaseWorkers']) as never,
      authDouble(),
      permissionsDouble(),
    ),
  );
  app.use('/api', createRecruitmentRoutes(authDouble(), permissionsDouble(), dubleDe('act', ['list']) as never));

  const scanned = scanExpressRouter(app);
  const entries: RouteCellEntry[] = MAPA.map((m) => {
    const hits = scanned.filter((r) => r.method === m.method && r.path === m.path);
    if (hits.length !== 1) throw new Error(`rota do mapa achada ${hits.length}x (esperado 1): ${m.method} ${m.path}`);
    const cell = hits[0].cell;
    if (!cell) throw new Error(`rota sem célula declarada: ${m.method} ${m.path}`);
    return { method: m.method, path: m.path, cell: cellKey(cell.resource, cell.action), irmas: m.irmas, enforcedIn: 'perm.require' };
  });
  // O bloco documents mora na rota-mãe; ela precisa existir na varredura.
  if (!entries.some((e) => e.method === DOCUMENTS.method && e.path === DOCUMENTS.path)) {
    throw new Error('rota-mãe do bloco documents ausente');
  }
  entries.splice(1, 0, { ...DOCUMENTS, irmas: [...DOCUMENTS.irmas] });
  return entries;
}

export function serializar(entries: RouteCellEntry[]): string {
  return JSON.stringify({ routes: entries }, null, 2) + '\n';
}

if (require.main === module) {
  gerarRouteCells()
    .then((entries) => {
      fs.writeFileSync(ROUTE_CELLS_PATH, serializar(entries));
      console.log(`route-cells.json escrito: ${entries.length} entradas`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
