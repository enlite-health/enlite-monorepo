/**
 * RegistrarDocumentoPacienteAnaCareController.test.ts
 *
 * Cobre:
 *   1. Corpo inválido (Zod) → 400 com `details`, use case NUNCA chamado.
 *   2. Caminho feliz (registrado) → 200 `{ success: true, data: { status: 'registrado', record } }`.
 *   3. Idempotente (ja_registrado) → 200.
 *   4. Erro nomeado → httpStatus por `mapError` (400/422/409).
 *   5. `registeredBy` vem de `req.authContext.principal.id` (ou 'unknown' sem auth context).
 */

import type { Request, Response } from 'express';
import { RegistrarDocumentoPacienteAnaCareController } from '../RegistrarDocumentoPacienteAnaCareController';
import {
  AnaCarePatientIdAusenteError,
  DocumentoInvalidoError,
  DocumentoJaRegistradoDivergenteError,
} from '../../../application/RegistrarDocumentoPacienteAnaCareUseCase';
import type { AnaCarePatientDocumentRecord } from '../../../domain/IAnaCarePatientDocumentRepository';

interface FakeRes {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
}

function makeRes(): FakeRes {
  const json = jest.fn();
  const status = jest.fn().mockImplementation(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

function makeReq(body: unknown, authContext?: { principal: { id: string } }): Request {
  return { body, authContext } as unknown as Request;
}

const VALID_BODY = { anaCarePatientId: 'ac-paciente-1', documentNumber: '30111222', documentType: 'DNI' };

function makeController(mockExecute: jest.Mock): RegistrarDocumentoPacienteAnaCareController {
  return new RegistrarDocumentoPacienteAnaCareController(() => ({ execute: mockExecute } as never));
}

const RECORD: AnaCarePatientDocumentRecord = {
  id: 'doc-1',
  anaCarePatientId: 'ac-paciente-1',
  documentNumber: '30111222',
  documentType: 'DNI',
  registeredBy: 'uid-staff-1',
  createdAt: new Date('2026-09-19T00:00:00Z'),
  updatedAt: new Date('2026-09-19T00:00:00Z'),
};

describe('RegistrarDocumentoPacienteAnaCareController.handle', () => {
  it.each([
    ['anaCarePatientId ausente', { documentNumber: '30111222' }],
    ['anaCarePatientId vazio', { ...VALID_BODY, anaCarePatientId: '' }],
    ['documentNumber ausente', { anaCarePatientId: 'ac-paciente-1' }],
    ['documentNumber vazio', { ...VALID_BODY, documentNumber: '' }],
  ])('corpo inválido (%s) → 400 com details, use case não chamado', async (_label, body) => {
    const mockExecute = jest.fn();
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(body), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Invalid request body', details: expect.anything() }),
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('caminho feliz — registrado → 200 com status e record', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ status: 'registrado', record: RECORD });
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY, { principal: { id: 'uid-staff-1' } }), res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: { status: 'registrado', record: RECORD } });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ ...VALID_BODY, registeredBy: 'uid-staff-1' }));
  });

  it('idempotente — ja_registrado → 200', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ status: 'ja_registrado', record: RECORD });
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: { status: 'ja_registrado', record: RECORD } });
  });

  it('sem authContext → registeredBy é "unknown"', async () => {
    const mockExecute = jest.fn().mockResolvedValue({ status: 'registrado', record: RECORD });

    await makeController(mockExecute).handle(makeReq(VALID_BODY), makeRes().res);

    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ registeredBy: 'unknown' }));
  });

  it.each([
    [new AnaCarePatientIdAusenteError(), 400, 'AnaCarePatientIdAusenteError'],
    [new DocumentoInvalidoError('invalido'), 422, 'DocumentoInvalidoError'],
    [new DocumentoJaRegistradoDivergenteError('ac-paciente-1', RECORD), 409, 'DocumentoJaRegistradoDivergenteError'],
    [new Error('boom'), 500, 'UnknownError'],
  ] as const)('mapError: %p → httpStatus %i, errorType %s', async (err, expectedStatus, expectedErrorType) => {
    const mockExecute = jest.fn().mockRejectedValue(err);
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: expectedErrorType }));
  });
});
