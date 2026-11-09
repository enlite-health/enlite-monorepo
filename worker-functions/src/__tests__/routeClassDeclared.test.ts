/**
 * acesso-do-cliente F3, T309: toda rota `service`/`public`/`staff` dos routers abaixo declara
 * classe (`routeClass(...)` ou o `requireStaff`). Varre o router REAL com `scanExpressRouter`
 * (controllers-dublê) e reprova se alguma rota ficar com `class == null`. A contagem esperada
 * de rotas por router é fixa: `0` rotas varridas é falha, não sucesso.
 */
import express from 'express';
import { scanExpressRouter } from '@modules/identity/permissions';

// Os controllers de webhook abrem conexão com o banco no construtor; aqui só a montagem importa.
jest.mock('@modules/integration/interfaces/webhooks/controllers/TalentumWebhookController', () => ({ TalentumWebhookController: class {} }));
jest.mock('@modules/notification/interfaces/controllers/TwilioWebhookController', () => ({ TwilioWebhookController: class {} }));

const dub = <T>(): T => ({}) as T;

function varrer(montar: (app: express.Express) => void) {
  const app = express();
  montar(app);
  return scanExpressRouter(app);
}

function esperarClasse(rotas: ReturnType<typeof scanExpressRouter>, total: number, classe: string) {
  expect(rotas).toHaveLength(total);
  expect(rotas.filter((r) => r.class == null)).toEqual([]);
  expect(rotas.every((r) => r.class === classe)).toBe(true);
}

describe('T309 lote 1 — rotas service declaram classe', () => {
  it('anacareHoursSyncRoutes (interna)', async () => {
    const { createAnaCareHoursSyncInternalRoutes } = await import('@modules/anacare-hours/interfaces/routes/anacareHoursSyncRoutes');
    esperarClasse(varrer((a) => a.use('/api/internal', createAnaCareHoursSyncInternalRoutes(dub()))), 1, 'service');
  });
  it('itineraryDailyInternalRoutes', async () => {
    const { createItineraryDailyInternalRoutes } = await import('@modules/case/interfaces/routes/itineraryDailyInternalRoutes');
    esperarClasse(varrer((a) => a.use('/api/internal', createItineraryDailyInternalRoutes(dub()))), 1, 'service');
  });
  it('therapeuticContactRemindersInternalRoutes', async () => {
    const { createTherapeuticContactRemindersInternalRoutes } = await import('@modules/case/interfaces/routes/therapeuticContactRemindersInternalRoutes');
    esperarClasse(varrer((a) => a.use('/api/internal', createTherapeuticContactRemindersInternalRoutes(dub()))), 1, 'service');
  });
});

const passa: express.RequestHandler = (_req, _res, next) => next();

describe('T309 lote 2 — rotas service declaram classe', () => {
  it('permissionRoutesInventoryRoute', async () => {
    const { createPermissionRoutesInventoryRouter } = await import('@modules/identity/interfaces/routes/permissionRoutesInventoryRoute');
    esperarClasse(varrer((a) => a.use('/.well-known', createPermissionRoutesInventoryRouter(dub(), passa))), 1, 'service');
  });
  it('wellKnownPermissionsRoute', async () => {
    const { createWellKnownPermissionsRouter } = await import('@modules/identity/permissions/interface/wellKnownPermissionsRoute');
    esperarClasse(varrer((a) => a.use('/.well-known', createWellKnownPermissionsRouter(dub(), passa, { ownerService: 'x' }))), 1, 'service');
  });
  it('webhookRoutes (4 rotas por montagem; o TSV conta 2 montagens = 8)', async () => {
    const { createWebhookRoutes } = await import('@modules/integration/interfaces/webhooks/routes/webhookRoutes');
    const partner = { requirePartnerKey: () => passa } as never;
    const rotas = varrer((a) => {
      a.use('/api/webhooks', createWebhookRoutes(partner, dub(), dub()));
      a.use('/api/webhooks-test', createWebhookRoutes(partner, dub(), dub()));
    });
    esperarClasse(rotas, 8, 'service');
  });
  it('mcpRoutes', async () => {
    const { createMcpRoutes } = await import('@modules/mcp/interfaces/routes/mcpRoutes');
    esperarClasse(varrer((a) => a.use('/mcp', createMcpRoutes({ principalRepo: dub(), auditor: dub(), registry: dub(), serverName: 'x', serverVersion: '1' }))), 3, 'service');
  });
});

describe('T309 lote 3 — rotas service de admissão declaram classe', () => {
  const R = '@modules/matching/interfaces/routes';
  it('admissionImportRoutes', async () => {
    const { createAdmissionImportInternalRoutes } = await import(`${R}/admissionImportRoutes`);
    esperarClasse(varrer((a) => a.use('/api/internal', createAdmissionImportInternalRoutes(dub()))), 1, 'service');
  });
  it('admissionLiveRoutes', async () => {
    const { createAdmissionLiveInternalRoutes } = await import(`${R}/admissionLiveRoutes`);
    esperarClasse(varrer((a) => a.use('/api/internal', createAdmissionLiveInternalRoutes(dub()))), 1, 'service');
  });
  it('admissionPostCallRoutes', async () => {
    const { createAdmissionPostCallInternalRoutes } = await import(`${R}/admissionPostCallRoutes`);
    esperarClasse(varrer((a) => a.use('/api/internal', createAdmissionPostCallInternalRoutes(dub()))), 1, 'service');
  });
  it('chromeReportRoutes', async () => {
    const { createChromeReportInternalRoutes } = await import(`${R}/chromeReportRoutes`);
    esperarClasse(varrer((a) => a.use('/api/internal', createChromeReportInternalRoutes(dub()))), 1, 'service');
  });
});
