/**
 * acesso-do-cliente F3, T313: cobertura de classe sobre os routers REAIS.
 *
 * Monta cada fábrica de router do `src` com AuthMiddleware/PermissionMiddleware REAIS (as marcas
 * `staff` e as células nascem do código de produção) e controllers-dublê, varre com
 * `scanExpressRouter` e exige 0 rotas sem classe, sem célula e sem isenção — a mesma condição em
 * que o selo (`sealUnclassifiedRoutes`) devolve 403. `0` rotas varridas é falha, não sucesso.
 *
 * Fecha a lacuna da rota NOVA: todo arquivo de `src` que cria `Router()` precisa estar em
 * FABRICAS ou em FORA_DO_ESCOPO; arquivo novo fora das duas listas reprova.
 *
 * Fora do alcance de unit: as ~30 rotas inline de `src/index.ts` e `startServer.ts` (não
 * importáveis, fatos F4) — são do e2e `route-class-inventory` (T315).
 * Este arquivo cobre o mesmo chão que `routeClassDeclared` (lotes service) e
 * `routeClassCoverageClientRouters` (prestador), que continuam valendo; não funde nem apaga.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import { scanExpressRouter, type ScannedRoute } from '@modules/identity/permissions';
import { AuthMiddleware } from '@modules/identity/interfaces/middleware/AuthMiddleware';
import { PermissionMiddleware } from '@modules/identity/interfaces/middleware/PermissionMiddleware';
import { unclassifiedRoutes } from '@modules/identity/interfaces/middleware/sealUnclassifiedRoutes';

// Os controllers de webhook abrem conexão com o banco no construtor; aqui só a montagem importa.
jest.mock('@modules/integration/interfaces/webhooks/controllers/TalentumWebhookController', () => ({ TalentumWebhookController: class {} }));
jest.mock('@modules/notification/interfaces/controllers/TwilioWebhookController', () => ({ TwilioWebhookController: class {} }));
// Controllers/repositórios abrem `DatabaseConnection.getInstance()` no construtor; nada aqui toca banco.
jest.mock('@shared/database/DatabaseConnection', () => {
  const fn = function () {};
  const dub: any = new Proxy(fn, {
    get: (_t, p) => (typeof p === 'symbol' || p === 'then' ? undefined : p === 'length' ? 0 : dub),
    apply: () => dub,
    construct: () => dub,
  });
  return { DatabaseConnection: { getInstance: () => dub }, default: dub };
});

/** Dublê profundo: qualquer leitura/chamada devolve outro dublê; símbolos/`then` somem (a marca nunca vem dele). */
function deep(): any {
  const target = function () {};
  const proxy: any = new Proxy(target, {
    get: (_t, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop === 'length') return 0;
      return deep();
    },
    apply: () => deep(),
    construct: () => deep(),
  });
  return proxy;
}

const realAuth = new AuthMiddleware(deep(), deep());
const realPerm = new PermissionMiddleware({ client: deep(), audit: deep() });

/** Argumento universal: métodos do auth/perm reais; o resto, dublê profundo (controllers, serviços, pools). */
function universal(): any {
  return new Proxy(deep(), {
    get: (t, prop, recv) => {
      if (typeof prop === 'string') {
        // Fábricas que recebem objeto de deps (`{ auth, permissions, ... }`).
        if (prop === 'auth' || prop === 'authMiddleware') return realAuth;
        if (prop === 'permissions' || prop === 'permissionMiddleware') return realPerm;
        if (prop in realAuth && typeof (realAuth as any)[prop] === 'function') return (realAuth as any)[prop].bind(realAuth);
        if (prop in realPerm && typeof (realPerm as any)[prop] === 'function') return (realPerm as any)[prop].bind(realPerm);
      }
      return Reflect.get(t, prop, recv);
    },
  });
}

const SRC = path.resolve(__dirname, '..');

/** Fábricas montadas pelo `index.ts`/`startServer.ts` (caminho relativo a `src/`, sem `.ts`). */
const FABRICAS = [
  'interfaces/routes/dedupRoutes',
  'interfaces/routes/testFixturesRoutes',
  'modules/account-link/accountLinkRoutes',
  'modules/agentes/interfaces/routes/adminAssistantsRoutes',
  'modules/agentes/interfaces/routes/adminLuzPruebaRoutes',
  'modules/agentes/interfaces/routes/adminPedidosIaRoutes',
  'modules/anacare-hours/interfaces/routes/anacareHoursRoutes',
  'modules/anacare-hours/interfaces/routes/anacareHoursSyncRoutes',
  'modules/auth/interfaces/routes/claimRoutes',
  'modules/case/interfaces/routes/adminInsuranceRoutes',
  'modules/case/interfaces/routes/adminItineraryChangesRoutes',
  'modules/case/interfaces/routes/adminItineraryWriteRoutes',
  'modules/case/interfaces/routes/adminPatientPhotoRoutes',
  'modules/case/interfaces/routes/adminPatientsRoutes',
  'modules/case/interfaces/routes/adminServiceTeamContactRoutes',
  'modules/case/interfaces/routes/adminServiceTeamRoutes',
  'modules/case/interfaces/routes/adminSubstitutionRequestRoutes',
  'modules/case/interfaces/routes/adminTherapeuticProjectsRoutes',
  'modules/case/interfaces/routes/itineraryDailyInternalRoutes',
  'modules/case/interfaces/routes/therapeuticContactRemindersInternalRoutes',
  'modules/conversation/interfaces/routes/adminConversationRoutes',
  'modules/custos/interfaces/routes/adminCostsRoutes',
  'modules/identity/interfaces/adminAreaMembershipRoutes',
  'modules/identity/interfaces/meAreasRoute',
  'modules/identity/interfaces/personTreeRoute',
  'modules/identity/interfaces/routes/adminStaffDirectoryRoutes',
  'modules/identity/interfaces/routes/adminUsersRoutes',
  'modules/identity/interfaces/routes/authTelemetryRoutes',
  'modules/identity/interfaces/routes/permissionPanelRoutes',
  'modules/identity/interfaces/routes/permissionPanelWriteRoutes',
  'modules/identity/interfaces/routes/permissionRoutesInventoryRoute',
  'modules/identity/permissions/interface/meAuthzRoute',
  'modules/identity/permissions/interface/meSimulationRoute',
  'modules/identity/permissions/interface/wellKnownPermissionsRoute',
  'modules/inapp-notification/interfaces/routes/adminNotificationRoutes',
  'modules/integration/interfaces/routes/adminAiPromptRoutes',
  'modules/integration/interfaces/routes/adminIntegrationsRoutes',
  'modules/integration/interfaces/webhooks/routes/webhookRoutes',
  'modules/matching/interfaces/routes/adminAdmissionRoutes',
  'modules/matching/interfaces/routes/adminEnquadreEventListRoutes',
  'modules/matching/interfaces/routes/adminEnquadreEventRoutes',
  'modules/matching/interfaces/routes/adminInterviewHostRoutes',
  'modules/matching/interfaces/routes/adminVacanciesRoutes',
  'modules/matching/interfaces/routes/admissionImportRoutes',
  'modules/matching/interfaces/routes/admissionLiveRoutes',
  'modules/matching/interfaces/routes/admissionPostCallRoutes',
  'modules/matching/interfaces/routes/analyticsRoutes',
  'modules/matching/interfaces/routes/chromeReportRoutes',
  'modules/matching/interfaces/routes/enquadreJobRoutes',
  'modules/matching/interfaces/routes/funnelStageMessagesRoutes',
  'modules/matching/interfaces/routes/recruitmentRoutes',
  'modules/matching/interfaces/routes/tactiqLinkRoutes',
  'modules/matching/interfaces/routes/templateCatalogRoutes',
  'modules/matching/interfaces/routes/templateDraftsRoutes',
  'modules/matching/interfaces/routes/transitCorridorRoutes',
  'modules/matching/interfaces/routes/workerApplicationsRoutes',
  'modules/matching/interfaces/routes/workerContextRoutes',
  'modules/matching/interfaces/routes/workerEncuadreRoutes',
  'modules/mcp/interfaces/oauth/consentRoutes',
  'modules/mcp/interfaces/routes/mcpRoutes',
  'modules/notification/interfaces/routes/internalRoutes',
  'modules/notification/interfaces/routes/messagingRoutes',
  'modules/notification/interfaces/routes/presentationInviteRoutes',
  'modules/patient-documents/interfaces/routes/patientDocumentsRoutes',
  'modules/presence/interfaces/routes/adminPresenceRoutes',
  'modules/reconciliation/interfaces/routes/patientReconciliationRoutes',
  'modules/worker/interfaces/routes/adminWorkerDocumentsRoutes',
  'modules/worker/interfaces/routes/adminWorkerRoutes',
  'modules/worker/interfaces/routes/workerDocumentsRoutes',
  'shared/openapi/swaggerRouter',
] as const;

/** Arquivos com `Router()` que NÃO são fábrica montada em produção (cada um com o motivo). */
const FORA_DO_ESCOPO: Record<string, string> = {
  'modules/matching/interfaces/routes/talentumRoutes':
    'exporta `router` default (`POST /prescreening`) que nenhum arquivo monta: só o índice do módulo reexporta (grep em src = 0 usos)',
};

function arquivosComRouter(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      arquivosComRouter(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      if (/\bRouter\(\)/.test(fs.readFileSync(full, 'utf8'))) out.push(path.relative(SRC, full).replace(/\.ts$/, ''));
    }
  }
  return out;
}

/** Fábricas cujo argumento tem forma que o dublê universal não imita. */
const ARGS_ESPECIAIS: Record<string, () => unknown[]> = {
  createSwaggerRouter: () => [{ guards: [] }], // dev/test: sem `requireStaff`; a marca vem do handler
};

const FABRICA_NOME = /^create.*(Routes?|Router)$/;

async function montar(arquivo: string): Promise<ScannedRoute[]> {
  const mod = await import(path.join(SRC, arquivo));
  const nomes = Object.keys(mod).filter((n) => FABRICA_NOME.test(n) && typeof mod[n] === 'function');
  expect({ arquivo, fabricas: nomes.length > 0 }).toEqual({ arquivo, fabricas: true });
  const app = express();
  for (const nome of nomes) {
    const args = ARGS_ESPECIAIS[nome]?.() ?? Array.from({ length: 16 }, universal);
    const router = mod[nome](...args);
    app.use('/', router);
  }
  return scanExpressRouter(app).filter((r) => r.method !== 'USE');
}

describe('T313 — cobertura de classe sobre os routers reais', () => {
  it('todo arquivo de src com Router() está em FABRICAS ou FORA_DO_ESCOPO (rota nova não passa batida)', () => {
    const conhecidos = new Set<string>([...FABRICAS, ...Object.keys(FORA_DO_ESCOPO)]);
    const achados = arquivosComRouter(SRC);
    expect(achados.length).toBeGreaterThan(0);
    expect(achados.filter((a) => !conhecidos.has(a))).toEqual([]);
    expect([...conhecidos].filter((c) => !achados.includes(c) && !FABRICAS.includes(c as never))).toEqual([]);
  });

  it.each(FABRICAS)('%s: 0 rotas sem classe, sem célula e sem isenção', async (arquivo) => {
    const rotas = await montar(arquivo);
    expect(rotas.length).toBeGreaterThan(0); // 0 = não medi, não sucesso
    expect(unclassifiedRoutes(rotas).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('total: soma das rotas varridas é fixa e nenhuma ficou sem classe', async () => {
    let total = 0;
    const sem: string[] = [];
    for (const arquivo of FABRICAS) {
      const rotas = await montar(arquivo);
      total += rotas.length;
      sem.push(...unclassifiedRoutes(rotas).map((r) => `${arquivo}: ${r.method} ${r.path}`));
    }
    expect(sem).toEqual([]);
    expect(total).toBe(443);
  });
});
