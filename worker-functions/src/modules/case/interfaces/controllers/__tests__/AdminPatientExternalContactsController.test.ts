/**
 * AdminPatientExternalContactsController — escrita por LINHA (spec 018, PR-2, `lex` #4).
 * Repos e `inPatientTransaction` mockados: a prova end-to-end (SQL real, RLS, célula real) é o
 * e2e `tests/e2e/patient-external-contacts.e2e.test.ts`. Aqui: validação/erro/guarda.
 * Molde: AdminPatientContactRowsController.test.ts.
 */
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));
const mockInPatientTransaction = jest.fn((fn: (client: unknown) => unknown) => fn({ marker: 'client' }));
jest.mock('../../../application/patientTransaction', () => ({
  inPatientTransaction: (fn: (client: unknown) => unknown) => mockInPatientTransaction(fn),
}));

import { AdminPatientExternalContactsController } from '../AdminPatientExternalContactsController';
import { EmergencyContactRequiresPhoneError } from '../../../infrastructure/EmergencyContactRequiresPhoneError';
import { AuthMiddleware } from '@modules/identity';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONTACT_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}
const db = () => ({ query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });

describe('AdminPatientExternalContactsController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInPatientTransaction.mockImplementation((fn: (client: unknown) => unknown) => fn({ marker: 'client' }));
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  describe('create', () => {
    it('400 quando :id não é UUID; o repositório não é chamado', async () => {
      const repo = { insertOne: jest.fn() };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it('400 quando o corpo não tem relation/name', async () => {
      const repo = { insertOne: jest.fn() };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { insertOne: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientExternalContactsController(repo as never, pool as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { relation: 'NEIGHBOR', name: 'Vecina' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it('201 com {id}; uid do ator vai ao repositório via o client da transação', async () => {
      const repo = { insertOne: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { relation: 'TEACHER', name: 'Prof. X', phone: '11-5555' } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: CONTACT_ID } });
      expect(repo.insertOne).toHaveBeenCalledWith(PATIENT_ID, { relation: 'TEACHER', name: 'Prof. X', phone: '11-5555' }, 'uid-1', { marker: 'client' });
    });

    it('lex C6 — sem contexto de auth, a escrita é RECUSADA (500)', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const repo = { insertOne: jest.fn() };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { relation: 'OTHER', name: 'X' } }), res);
      expect(repo.insertOne).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-cru'],
    ])('500 em erro inesperado do repositório — quando a rejeição %s', async (_label, rejeicao) => {
      const repo = { insertOne: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { relation: 'OTHER', name: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('update', () => {
    it('400 quando :xid não é UUID', async () => {
      const repo = { updateOne: jest.fn() };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, xid: 'x' }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.updateOne).not.toHaveBeenCalled();
    });

    it('400 quando o corpo tem relation fora do enum', async () => {
      const repo = { updateOne: jest.fn() };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID }, body: { relation: 'THERAPIST' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.updateOne).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { updateOne: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientExternalContactsController(repo as never, pool as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID }, body: { name: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 quando o repositório devolve null (linha inexistente ou de outro paciente)', async () => {
      const repo = { updateOne: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID }, body: { name: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 com {id} quando encontrado', async () => {
      const repo = { updateOne: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID }, body: { phone: '1' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.updateOne).toHaveBeenCalledWith(PATIENT_ID, CONTACT_ID, { phone: '1' }, { marker: 'client' });
    });

    it('422 EMERGENCY_CONTACT_REQUIRES_PHONE quando o PATCH apaga o telefone de um contato marcado (migration 423)', async () => {
      const repo = { updateOne: jest.fn().mockRejectedValue(new EmergencyContactRequiresPhoneError()) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID }, body: { phone: null } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: expect.any(String), code: 'EMERGENCY_CONTACT_REQUIRES_PHONE' });
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-cru'],
    ])('500 em erro inesperado do repositório — quando a rejeição %s', async (_label, rejeicao) => {
      const repo = { updateOne: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID }, body: { name: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('deactivate', () => {
    it('400 quando :xid não é UUID', async () => {
      const repo = { deactivate: jest.fn() };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.deactivate).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe (nem chega a chamar o repositório)', async () => {
      const repo = { deactivate: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientExternalContactsController(repo as never, pool as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.deactivate).not.toHaveBeenCalled();
    });

    it('404 quando outcome = not_found', async () => {
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'not_found' }) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('409 quando outcome = already_inactive', async () => {
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'already_inactive' }) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('200 { emergencyMarkCleared: false } quando o repositório não informa o campo (`?? false`)', async () => {
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'deactivated', id: CONTACT_ID }) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID } }), res);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: CONTACT_ID, active: false, emergencyMarkCleared: false } });
    });

    it('200 { id, active:false, emergencyMarkCleared } quando desativado; uid do ator vai ao repositório', async () => {
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'deactivated', id: CONTACT_ID, emergencyMarkCleared: true }) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: CONTACT_ID, active: false, emergencyMarkCleared: true } });
      expect(repo.deactivate).toHaveBeenCalledWith(PATIENT_ID, CONTACT_ID, 'uid-1', { marker: 'client' });
    });

    it('lex C6 — sem contexto de auth, a escrita é RECUSADA (500)', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'deactivated', id: CONTACT_ID }) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID } }), res);
      expect(repo.deactivate).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-cru'],
    ])('500 em erro inesperado — quando a rejeição %s', async (_label, rejeicao) => {
      const repo = { deactivate: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientExternalContactsController(repo as never, db() as never);
      const res = mockRes();
      await controller.deactivate(mockReq({ params: { id: PATIENT_ID, xid: CONTACT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
