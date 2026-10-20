/**
 * 058b T226b — log sem pessoa. Nos 4 caminhos de erro CONHECIDO que a Parte B abre (cancelamento 409,
 * Trava A, Trava B, REGRA-05) nada que identifique paciente/serviço/prestador pode ir para log nem para `reportError`.
 * O caso CONTROLE prova que o espião enxerga um id logado de propósito (sem ele, "não contém" seria vácuo).
 */
jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: jest.fn().mockReturnValue(undefined) },
}));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/audit/contactAccessFromRequest', () => ({ emitirTrilhaDeContato: jest.fn() }));

import { Request, Response } from 'express';
import { reportError, logger } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { AdminItineraryWriteController } from '../AdminItineraryWriteController';
import { WorkerHasScheduledAttendancesError } from '../../../domain/serviceExitReason';
import { AdminPatientContractedServicesController } from '../AdminPatientContractedServicesController';
import { ServiceAddressLockedError } from '../../../infrastructure/PatientContractedServiceRepository';

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const SERVICE_ID = '22222222-2222-2222-2222-222222222222';
const ALLOCATION_ID = '44444444-4444-4444-4444-444444444444';
const WORKER_ID = '55555555-5555-5555-5555-555555555555';
const ADDRESS_ID = '66666666-6666-6666-6666-666666666666';

function reqRes(params: Record<string, unknown> = {}, body: Record<string, unknown> = {}, actorId: string | null = 'staff-1'): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const req = { params, body, query: {} } as unknown as Request;
  (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(actorId ? { principal: { id: actorId } } : undefined);
  return [req, { json, status } as unknown as Response];
}

/** `res` encadeável (`status().json()`), como o molde do controller de serviços contratados. */
function reqResPlain(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

/** Tudo que foi parar em log/`reportError`, serializado — o teste procura pessoa aí. */
function tudoQueFoiLogado(): string {
  const logs = ['info', 'warn', 'error'].flatMap((k) => (logger as unknown as Record<string, jest.Mock>)[k].mock.calls);
  return JSON.stringify([(reportError as jest.Mock).mock.calls, logs]);
}

describe('058b — log sem pessoa', () => {
  beforeEach(() => jest.clearAllMocks());

  it('CONTROLE: o spy enxerga um id de pessoa logado de propósito', () => {
    reportError(new Error('x'), { workerId: WORKER_ID });
    expect(tudoQueFoiLogado()).toContain(WORKER_ID);
  });

  it('caminho 3 — cancelamento: 409 WORKER_HAS_SCHEDULED_ATTENDANCES não loga nenhum id de pessoa', async () => {
    const removeUseCase = { execute: jest.fn().mockRejectedValue(new WorkerHasScheduledAttendancesError(['2026-10-26'], null)) };
    const ctrl = new AdminItineraryWriteController({} as never, {} as never, {} as never, {} as never, removeUseCase as never, {} as never);
    const [req, res] = reqRes(
      { id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID },
      { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE' },
    );
    await ctrl.endAllocation(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(reportError).not.toHaveBeenCalled();
    const logado = tudoQueFoiLogado();
    expect(logado).not.toContain(WORKER_ID);
    expect(logado).not.toContain(PATIENT_ID);
  });

  it('caminho 4 — REGRA-05: 422 SERVICE_ADDRESS_LOCKED não loga paciente, serviço nem endereço', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({ patientId: PATIENT_ID }),
      update: jest.fn().mockRejectedValue(new ServiceAddressLockedError('ALLOCATION')),
    };
    const ctrl = new AdminPatientContractedServicesController(repo as never, {} as never);
    const res = reqResPlain();
    await ctrl.update({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { addressId: ADDRESS_ID }, user: { roles: ['admin'] } } as never, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'ALLOCATION' } }));
    expect(reportError).not.toHaveBeenCalled();
    const logado = tudoQueFoiLogado();
    expect(logado).not.toContain(PATIENT_ID);
    expect(logado).not.toContain(SERVICE_ID);
    expect(logado).not.toContain(ADDRESS_ID);
  });
});
