/**
 * Família `admin.integrations` (task 3.5-A4): mesma célula NOVA (`integration:execute`, fora do
 * seed da 206) reaproveitada por 3 das 4 rotas do router — backfill AnaCare (F0) + lançamento
 * unitário e em lote do Axonico (F4, `integracao-axonico`). Uma célula, N rotas — não uma célula
 * por rota.
 *
 * A 4ª rota (`POST /integrations/anacare/patient-document`, migration 446) declara
 * `patient_identity:create` — célula DIFERENTE, de propósito: a ação é honestamente `create`
 * (registro do documento do paciente), não `execute` contra terceiro.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminIntegrationsRoutes, ADMIN_INTEGRATIONS_FAMILY } from '../adminIntegrationsRoutes';
import { AxonicoApiClient } from '../../../infrastructure/AxonicoApiClient';
import { LancarPrestacaoAxonicoUseCase } from '../../../application/LancarPrestacaoAxonicoUseCase';
import { RegistrarDocumentoPacienteAnaCareUseCase } from '../../../application/RegistrarDocumentoPacienteAnaCareUseCase';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

jest.mock('../../controllers/AnaCareBackfillController', () => ({
  AnaCareBackfillController: jest.fn().mockImplementation(() => ({
    handle: (_req: express.Request, res: express.Response) => res.json({ m: 'handle' }),
  })),
}));

// Captura a factory (`useCaseFactory`) passada ao construtor pelo router — permite invocá-la
// diretamente para cobrir o corpo da factory (linhas 44-48 do router), sem depender de rede real.
// Nome com prefixo `mock` é exigido pelo babel-plugin-jest-hoist para variável referenciada de
// dentro do factory de `jest.mock` (restrição de escopo do hoist).
let mockLancarFactory: (() => Promise<LancarPrestacaoAxonicoUseCase>) | undefined;
jest.mock('../../controllers/LancarPrestacaoAxonicoController', () => ({
  LancarPrestacaoAxonicoController: jest.fn().mockImplementation((factory) => {
    mockLancarFactory = factory;
    return {
      handle: (_req: express.Request, res: express.Response) => res.json({ m: 'handle-comprobante' }),
      handleLote: (_req: express.Request, res: express.Response) => res.json({ m: 'handle-lote' }),
    };
  }),
}));

let mockPatientDocFactory: (() => RegistrarDocumentoPacienteAnaCareUseCase) | undefined;
jest.mock('../../controllers/RegistrarDocumentoPacienteAnaCareController', () => ({
  RegistrarDocumentoPacienteAnaCareController: jest.fn().mockImplementation((factory) => {
    mockPatientDocFactory = factory;
    return {
      handle: (_req: express.Request, res: express.Response) => res.json({ m: 'handle-patient-document' }),
    };
  }),
}));

function build(): express.Router {
  return createAdminIntegrationsRoutes(authDouble(), permissionsDouble());
}

describe('família admin.integrations', () => {
  it('a família é `admin.integrations`', () => {
    expect(ADMIN_INTEGRATIONS_FAMILY).toBe('admin.integrations');
  });

  it('3 das 4 rotas declaram integration:execute — célula NOVA da D116', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas).toHaveLength(4);
    const executeRotas = rotas.filter((r) => r.path !== '/integrations/anacare/patient-document');
    expect(executeRotas).toHaveLength(3);
    for (const rota of executeRotas) {
      expect(rota.cell).toMatchObject({ resource: 'integration', action: 'execute' });
    }
  });

  it('`execute`, não `write`: backfill/lançamento DISPARAM ação contra terceiro', () => {
    // A distinção não é estilo — `execute` está em SENSITIVE_ACTIONS (D-P4),
    // então o ALLOW também vai para a trilha. Com `write` não iria.
    const rotas = scanExpressRouter(build()).filter((r) => r.path !== '/integrations/anacare/patient-document');
    for (const rota of rotas) {
      expect(cellKey(rota.cell!.resource, rota.cell!.action)).toBe('integration:execute');
    }
  });

  it('a rota de documento do paciente declara patient_identity:create (registro honesto, nunca write)', () => {
    const rotas = scanExpressRouter(build());
    const patientDocumentRoute = rotas.find((r) => r.path === '/integrations/anacare/patient-document');
    expect(patientDocumentRoute?.cell).toMatchObject({ resource: 'patient_identity', action: 'create' });
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a rota chega no handler do backfill', async () => {
    const app = express();
    app.use('/api/admin', build());

    const res = await request(app).post('/api/admin/integrations/anacare/backfill').expect(200);

    expect(res.body.m).toBe('handle');
  });

  it('a rota chega no handler unitário do Axonico (comprobante)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());

    const res = await request(app).post('/api/admin/integrations/axonico/comprobante').send({}).expect(200);

    expect(res.body.m).toBe('handle-comprobante');
  });

  it('a rota chega no handler de lote do Axonico (comprobante/lote)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());

    const res = await request(app).post('/api/admin/integrations/axonico/comprobante/lote').send({}).expect(200);

    expect(res.body.m).toBe('handle-lote');
  });

  it('a rota chega no handler de documento do paciente', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());

    const res = await request(app).post('/api/admin/integrations/anacare/patient-document').send({}).expect(200);

    expect(res.body.m).toBe('handle-patient-document');
  });

  it('a factory do Axonico memoiza `AxonicoApiClient.create()` e monta o use case de lançamento', async () => {
    // Corpo da factory lazy passada ao `LancarPrestacaoAxonicoController` (linhas 44-48 do
    // router): só roda quando a rota é de fato chamada — aqui a invocamos direto, sem rede real,
    // porque `AxonicoApiClient.create()` está espiado para resolver na hora.
    const fakeClient = {} as AxonicoApiClient;
    const createSpy = jest.spyOn(AxonicoApiClient, 'create').mockResolvedValue(fakeClient);

    build();
    expect(mockLancarFactory).toBeDefined();

    const useCase1 = await mockLancarFactory!();
    const useCase2 = await mockLancarFactory!();

    expect(useCase1).toBeInstanceOf(LancarPrestacaoAxonicoUseCase);
    expect(useCase2).toBeInstanceOf(LancarPrestacaoAxonicoUseCase);
    // Memoização: a MESMA promise de client é reaproveitada entre chamadas (não recria sessão).
    expect(createSpy).toHaveBeenCalledTimes(1);

    createSpy.mockRestore();
  });

  it('a factory do documento do paciente monta o use case de registro', () => {
    build();
    expect(mockPatientDocFactory).toBeDefined();

    const useCase = mockPatientDocFactory!();

    expect(useCase).toBeInstanceOf(RegistrarDocumentoPacienteAnaCareUseCase);
  });
});
