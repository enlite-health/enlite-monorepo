/**
 * adminInsuranceRoutes — as rotas do cadastro de obra social, contratos/termos e do vínculo serviço -> contrato (spec 058 §3.2; plan §1.4).
 *
 * Duas camadas: (1) o mapa rota -> célula, varrido do router REAL com o mesmo `scanExpressRouter` que alimenta o catálogo (mapa copiado do
 * plan, não do código); (2) o PermissionMiddleware REAL com o engine LIGADO para `admin.patients`, para provar o portão 403 do §L (spec §11):
 * quem não tem `insurance_provider_patients:read` não lista pacientes de obra social NEM com `patient_services:read` e `patient_coverage:read`.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { PermissionMiddleware } from '@modules/identity/interfaces/middleware/PermissionMiddleware';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminInsuranceRoutes } from '../adminInsuranceRoutes';
import type { AdminInsuranceProvidersController } from '../../controllers/AdminInsuranceProvidersController';
import type { AdminInsuranceProviderContactsController } from '../../controllers/AdminInsuranceProviderContactsController';
import type { AdminInsuranceContractsController } from '../../controllers/AdminInsuranceContractsController';
import type { AdminContractedServiceContractLinkController } from '../../controllers/AdminContractedServiceContractLinkController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const PATIENT = '11111111-1111-4111-8111-111111111111';
const SERVICE = '22222222-2222-4222-8222-222222222222';

/** Mapa esperado — copiado do plan §1.4 (todas `untilEnforced: 'admin'`, menos o vínculo, que usa `patient_services:update` como o resto do serviço). */
const ESPERADO: Record<string, string[]> = {
  'GET /insurance-providers': ['catalog_insurance_providers:read'],
  'GET /insurance-providers/for-service': ['insurance_contracts:read'],
  'GET /insurance-providers/:code': ['catalog_insurance_providers:read'],
  'PATCH /insurance-providers/:code': ['catalog_insurance_providers:update'],
  'GET /insurance-providers/:code/contacts': ['insurance_provider_contacts:read'],
  'POST /insurance-providers/:code/contacts': ['insurance_provider_contacts:create'],
  'PATCH /insurance-providers/:code/contacts/:contactId': ['insurance_provider_contacts:update'],
  'POST /insurance-providers/:code/contacts/:contactId/retire': ['insurance_provider_contacts:update'],
  'GET /insurance-providers/:code/contracts': ['insurance_contracts:read'],
  'POST /insurance-providers/:code/contracts': ['insurance_contracts:create', 'patient_contract_value:create'],
  'PATCH /insurance-contracts/:id': ['insurance_contracts:update'],
  'POST /insurance-contracts/:id/terms': ['patient_contract_value:create'],
  'POST /insurance-contracts/:id/terms/:termId/supersede': ['patient_contract_value:create'],
  'GET /insurance-providers/:code/patients': ['insurance_provider_patients:read'],
  'POST /patients/:id/contracted-services/:sid/contract-link': ['patient_services:update'],
  'POST /patients/:id/contracted-services/:sid/contract-link/end': ['patient_services:update'],
  'POST /patients/:id/contracted-services/:sid/contract-link/supersede': ['patient_services:update'],
};

function controllers() {
  const responde = (nome: string) => (req: express.Request, res: express.Response) => res.status(200).json({ m: nome, code: req.params.code, id: req.params.id });
  const providers = {
    search: responde('providers.search'), get: responde('providers.get'), patch: responde('providers.patch'),
    listForService: responde('providers.listForService'), listPatients: responde('providers.listPatients'),
  } as unknown as AdminInsuranceProvidersController;
  const contacts = { list: responde('contacts.list'), create: responde('contacts.create'), patch: responde('contacts.patch'), retire: responde('contacts.retire') } as unknown as AdminInsuranceProviderContactsController;
  const contracts = {
    list: responde('contracts.list'), create: responde('contracts.create'), patch: responde('contracts.patch'),
    addTerm: responde('contracts.addTerm'), supersedeTerm: responde('contracts.supersedeTerm'),
  } as unknown as AdminInsuranceContractsController;
  const link = { create: responde('link.create'), end: responde('link.end'), supersede: responde('link.supersede') } as unknown as AdminContractedServiceContractLinkController;
  return { providers, contacts, contracts, link };
}

function buildWith(permissions: PermissionMiddleware) {
  const c = controllers();
  return createAdminInsuranceRoutes(authDouble(), permissions, c.providers, c.contacts, c.contracts, c.link);
}

/** Engine LIGADO para `admin.patients`; o ator resolve ATIVO, num grupo, com exatamente as células dadas. */
function enforced(cells: string[]): PermissionMiddleware {
  return new PermissionMiddleware({
    client: {
      resolve: jest.fn().mockResolvedValue({
        uid: 'dublê-admin', tenantId: 't', status: 'ACTIVE', permissions: cells, countries: ['AR'],
        groups: [{ id: 'g', name: 'g' }], canSimulate: false, simulation: null,
      }),
      can: jest.fn(), isFeatureAvailable: jest.fn(), featureConfig: jest.fn(), invalidate: jest.fn(),
    },
    audit: { record: jest.fn() },
    env: { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.patients' },
  });
}

function appWith(cells: string[]): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', buildWith(enforced(cells)));
  return app;
}

describe('adminInsuranceRoutes — mapa rota -> célula', () => {
  const router = buildWith(permissionsDouble());
  const scanned = scanExpressRouter(router);

  it('o router declara EXATAMENTE as rotas do plan, cada uma com as células do plan (na ordem dos guards)', () => {
    const declaradas = Object.fromEntries(scanned.map((r) => [`${r.method} ${r.path}`, (r.cells ?? []).map((c) => cellKey(c.resource, c.action))]));
    expect(declaradas).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração de célula', () => {
    expect(undeclaredRoutes(scanned, () => true)).toEqual([]);
  });

  it('as 11 células novas aparecem todas no router (nenhuma sem consumidor)', () => {
    const usadas = new Set(scanned.flatMap((r) => (r.cells ?? []).map((c) => cellKey(c.resource, c.action))));
    for (const nova of [
      'catalog_insurance_providers:read', 'catalog_insurance_providers:update',
      'insurance_provider_contacts:read', 'insurance_provider_contacts:create', 'insurance_provider_contacts:update',
      'insurance_contracts:read', 'insurance_contracts:create', 'insurance_contracts:update',
      'patient_contract_value:create', 'insurance_provider_patients:read',
    ]) {
      expect(usadas.has(nova)).toBe(true);
    }
    // `catalog_insurance_providers:create` é o POST /catalogs/insurance-providers, que mora em adminPatientsRoutes (C4)
  });
});

describe('adminInsuranceRoutes — portão 403 do §L (insurance_provider_patients:read)', () => {
  it('§L 403: ator SEM a célula recebe 403 e o handler não roda — mesmo com patient_services:read e patient_coverage:read', async () => {
    const res = await request(appWith(['patient_services:read', 'patient_coverage:read', 'insurance_contracts:read', 'catalog_insurance_providers:read']))
      .get('/api/admin/insurance-providers/OSDE/patients');
    expect(res.status).toBe(403);
    expect(res.body.reason).toContain('insurance_provider_patients:read');
    expect(res.body.m).toBeUndefined();
  });

  it('§L com célula: ator SÓ com insurance_provider_patients:read (sem patient_services:read) recebe 200', async () => {
    const res = await request(appWith(['insurance_provider_patients:read'])).get('/api/admin/insurance-providers/OSDE/patients');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ m: 'providers.listPatients', code: 'OSDE' });
  });
});

describe('adminInsuranceRoutes — ordem das rotas e células compostas', () => {
  it('/insurance-providers/for-service NÃO é capturada por /:code (literal antes do parâmetro)', async () => {
    const app = appWith(['insurance_contracts:read', 'catalog_insurance_providers:read']);
    const forService = await request(app).get('/api/admin/insurance-providers/for-service?country=AR');
    expect(forService.body.m).toBe('providers.listForService');
    const get = await request(app).get('/api/admin/insurance-providers/OSDE');
    expect(get.body.m).toBe('providers.get');
  });

  it('for-service pede a célula de CONTRATOS (cascata do serviço), não a do cadastro: quem só lê o cadastro leva 403', async () => {
    const res = await request(appWith(['catalog_insurance_providers:read'])).get('/api/admin/insurance-providers/for-service?country=AR');
    expect(res.status).toBe(403);
  });

  it('POST de contrato grava preço: exige as DUAS células (insurance_contracts:create + patient_contract_value:create)', async () => {
    const url = '/api/admin/insurance-providers/OSDE/contracts';
    expect((await request(appWith(['insurance_contracts:create'])).post(url).send({})).status).toBe(403);
    expect((await request(appWith(['patient_contract_value:create'])).post(url).send({})).status).toBe(403);
    expect((await request(appWith(['insurance_contracts:create', 'patient_contract_value:create'])).post(url).send({})).status).toBe(200);
  });

  it('termo novo e reajuste são do valor-hora (patient_contract_value:create), não do cadastro do contrato', async () => {
    const terms = `/api/admin/insurance-contracts/${SERVICE}/terms`;
    expect((await request(appWith(['insurance_contracts:update'])).post(terms).send({})).status).toBe(403);
    expect((await request(appWith(['patient_contract_value:create'])).post(terms).send({})).status).toBe(200);
  });

  it('vínculo do serviço: as 3 rotas exigem patient_services:update', async () => {
    const base = `/api/admin/patients/${PATIENT}/contracted-services/${SERVICE}/contract-link`;
    for (const sufixo of ['', '/end', '/supersede']) {
      expect((await request(appWith(['patient_services:read'])).post(`${base}${sufixo}`).send({})).status).toBe(403);
      expect((await request(appWith(['patient_services:update'])).post(`${base}${sufixo}`).send({})).status).toBe(200);
    }
  });

  it('com o engine desligado (família não enforçada) as rotas de célula nova valem só para admin — a 058 nasce só-admin', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', buildWith(permissionsDouble())); // dublê injeta principal com papel admin
    expect((await request(app).get('/api/admin/insurance-providers/OSDE/patients')).status).toBe(200);
  });
});
