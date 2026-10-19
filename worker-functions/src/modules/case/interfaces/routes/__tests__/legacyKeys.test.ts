/**
 * Chave legada no corpo → 422 `LEGACY_FIELD_REMOVED` ANTES do ABAC (spec 058 §2.5, plan §1.4; T064).
 *
 * O router é o de VERDADE (`createAdminPatientsRoutes`), com o PermissionMiddleware REAL e o engine LIGADO para a família `admin.patients`. O ator
 * não tem célula nenhuma: se o `rejectLegacyKeys` vier DEPOIS do `perm.require` (ou sumir), a resposta é 403 e o bundle de front antigo em cache
 * não descobre o motivo. Quatro chaves, quatro testes: `hourlyValue`, `contractType`, `taxCondition` (rota de serviço) e `healthInsuranceMemberId`
 * (seção de cobertura).
 */
import express from 'express';
import request from 'supertest';
import { PermissionMiddleware } from '@modules/identity/interfaces/middleware/PermissionMiddleware';
import { authDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminPatientsRoutes } from '../adminPatientsRoutes';
import type { AdminPatientsController } from '../../controllers/AdminPatientsController';
import type { AdminPatientContractedServicesController } from '../../controllers/AdminPatientContractedServicesController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));
jest.mock('@modules/identity/interfaces/middleware/countryScopeGuard', () => ({
  requireCountryScope: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('@shared/audit/resourceAccessLog', () => ({
  logResourceAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const PATIENT = '11111111-1111-4111-8111-111111111111';
const SERVICE = '22222222-2222-4222-8222-222222222222';

/** Engine ligado para `admin.patients`; o ator resolve ATIVO, num grupo, com as células de `cells`. */
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

function build(cells: string[]) {
  const reached = jest.fn((_req: express.Request, res: express.Response) => res.status(200).json({ reached: true }));
  const controller = { updatePatientSection: reached } as unknown as AdminPatientsController;
  const services = { create: reached, update: reached } as unknown as AdminPatientContractedServicesController;
  const router = createAdminPatientsRoutes(
    controller, authDouble(), enforced(cells), {} as never, {} as never, {} as never, {} as never, {} as never, services, {} as never, {} as never,
    {} as never, {} as never, {} as never, // contactRows, externalContacts, emergencyContact (têm default que abre o pool)
  );
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  return { app, reached };
}

const CASOS: Array<{ key: string; method: 'post' | 'patch'; path: string; body: Record<string, unknown> }> = [
  { key: 'hourlyValue', method: 'post', path: `/api/admin/patients/${PATIENT}/contracted-services`, body: { serviceCode: 'AT', hourlyValue: 5000 } },
  { key: 'contractType', method: 'patch', path: `/api/admin/patients/${PATIENT}/contracted-services/${SERVICE}`, body: { contractType: 'PREPAGA' } },
  { key: 'taxCondition', method: 'post', path: `/api/admin/patients/${PATIENT}/contracted-services`, body: { serviceCode: 'AT', taxCondition: 'IVA_21' } },
  { key: 'healthInsuranceMemberId', method: 'patch', path: `/api/admin/patients/${PATIENT}/coverage`, body: { healthInsuranceMemberId: 'AF-123' } },
];

describe('chave legada → 422 LEGACY_FIELD_REMOVED antes do ABAC', () => {
  it.each(CASOS)('$key ($method $path): 422 mesmo para ator SEM célula nenhuma, e o valor nunca volta na resposta', async ({ method, path, body, key }) => {
    const { app, reached } = build([]);
    const res = await request(app)[method](path).send(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ success: false, error: 'LEGACY_FIELD_REMOVED', code: 'LEGACY_FIELD_REMOVED', details: { fields: [key] } });
    expect(JSON.stringify(res.body)).not.toMatch(/5000|PREPAGA|IVA_21|AF-123/);
    expect(reached).not.toHaveBeenCalled();
  });

  it('controle positivo: o MESMO corpo sem a chave legada, pelo mesmo ator sem célula, vai ao ABAC (403) — o ABAC continua valendo', async () => {
    const { app, reached } = build([]);
    const res = await request(app).post(`/api/admin/patients/${PATIENT}/contracted-services`).send({ serviceCode: 'AT' });
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it('controle positivo: com a célula e sem chave legada o corpo chega ao controller (200)', async () => {
    const { app, reached } = build(['patient_services:create', 'patient_services:update', 'patient_coverage:update']);
    expect((await request(app).post(`/api/admin/patients/${PATIENT}/contracted-services`).send({ serviceCode: 'AT' })).status).toBe(200);
    expect((await request(app).patch(`/api/admin/patients/${PATIENT}/contracted-services/${SERVICE}`).send({ active: false })).status).toBe(200);
    expect((await request(app).patch(`/api/admin/patients/${PATIENT}/coverage`).send({ affiliateId: 'AF-1' })).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(3);
  });

  it('a chave legada só conta no NÍVEL RAIZ do corpo (não lê valor aninhado) e corpo vazio/array passa para a validação normal', async () => {
    const { app, reached } = build(['patient_services:create']);
    expect((await request(app).post(`/api/admin/patients/${PATIENT}/contracted-services`).send({ serviceCode: 'AT', professionalProfile: 'hourlyValue' })).status).toBe(200);
    expect((await request(app).post(`/api/admin/patients/${PATIENT}/contracted-services`).send([{ hourlyValue: 1 }])).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(2);
  });
});
