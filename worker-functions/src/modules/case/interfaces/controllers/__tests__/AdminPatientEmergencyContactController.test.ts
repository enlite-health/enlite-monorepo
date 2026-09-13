/**
 * AdminPatientEmergencyContactController — marca de emergência (spec 018, PR-2, D-A, SUP-39).
 * Repositório e `inPatientTransaction` mockados; a prova end-to-end (SQL real, RLS, triggers da
 * 423) é o e2e `tests/e2e/patient-emergency-mark-api.e2e.test.ts`.
 */
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
const mockLoggerInfo = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: (...args: unknown[]) => mockLoggerInfo(...args) } }));
const mockInPatientTransaction = jest.fn((fn: (client: unknown) => unknown) => fn({ marker: 'client' }));
jest.mock('../../../application/patientTransaction', () => ({
  inPatientTransaction: (fn: (client: unknown) => unknown) => mockInPatientTransaction(fn),
}));

import { AdminPatientEmergencyContactController } from '../AdminPatientEmergencyContactController';
import { AuthMiddleware } from '@modules/identity';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RESPONSIBLE_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

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

describe('AdminPatientEmergencyContactController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInPatientTransaction.mockImplementation((fn: (client: unknown) => unknown) => fn({ marker: 'client' }));
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  describe('mark (PUT)', () => {
    it('400 quando :id não é UUID', async () => {
      const repo = { mark: jest.fn() };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: 'x' }, body: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.mark).not.toHaveBeenCalled();
    });

    it('400 quando o corpo tem kind fora do enum', async () => {
      const repo = { mark: jest.fn() };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'OUTRO', id: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.mark).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { mark: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientEmergencyContactController(repo as never, pool as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.mark).not.toHaveBeenCalled();
    });

    it('404 quando o contato não é do paciente ou está inativo (outcome not_found)', async () => {
      const repo = { mark: jest.fn().mockResolvedValue({ outcome: 'not_found' }) };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('422 EMERGENCY_CONTACT_REQUIRES_PHONE quando o contato não tem telefone (outcome requires_phone)', async () => {
      const repo = { mark: jest.fn().mockResolvedValue({ outcome: 'requires_phone' }) };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: expect.any(String), code: 'EMERGENCY_CONTACT_REQUIRES_PHONE' });
    });

    it('200 { emergencyContactRef } quando marcado; grava a trilha SEM nome/telefone', async () => {
      const repo = { mark: jest.fn().mockResolvedValue({ outcome: 'marked' }) };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { emergencyContactRef: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } } });
      expect(repo.mark).toHaveBeenCalledWith(PATIENT_ID, 'RESPONSIBLE', RESPONSIBLE_ID, { marker: 'client' });
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({
        msg: 'patient_emergency_contact.write', uid: 'uid-1', patientId: PATIENT_ID, kind: 'RESPONSIBLE', contactId: RESPONSIBLE_ID, op: 'mark',
      }));
      // 🔒 a trilha NUNCA leva nome/telefone — só ids.
      const logged = mockLoggerInfo.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(logged).sort()).toEqual(['contactId', 'kind', 'msg', 'op', 'patientId', 'uid']);
    });

    it('lex C6 — sem contexto de auth, a escrita é RECUSADA (500)', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const repo = { mark: jest.fn() };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } }), res);
      expect(repo.mark).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-cru'],
    ])('500 em erro inesperado — quando a rejeição %s', async (_label, rejeicao) => {
      const repo = { mark: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.mark(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'RESPONSIBLE', id: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('unmark (DELETE)', () => {
    it('400 quando :id não é UUID', async () => {
      const repo = { unmark: jest.fn(), getRef: jest.fn() };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.unmark(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.unmark).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { unmark: jest.fn(), getRef: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientEmergencyContactController(repo as never, pool as never);
      const res = mockRes();
      await controller.unmark(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.unmark).not.toHaveBeenCalled();
    });

    it('200 { emergencyContactRef: null } sempre que a chamada suceder (idempotente); grava a trilha com o kind/contactId ANTERIOR', async () => {
      const repo = {
        unmark: jest.fn().mockResolvedValue(undefined),
        getRef: jest.fn().mockResolvedValue({ kind: 'EXTERNAL', id: 'x1' }),
      };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.unmark(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { emergencyContactRef: null } });
      expect(repo.unmark).toHaveBeenCalledWith(PATIENT_ID, { marker: 'client' });
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({ op: 'unmark', kind: 'EXTERNAL', contactId: 'x1' }));
    });

    it('sem marca vigente: unmark ainda sucede (200), trilha leva kind/contactId null', async () => {
      const repo = { unmark: jest.fn().mockResolvedValue(undefined), getRef: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.unmark(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({ op: 'unmark', kind: null, contactId: null }));
    });

    it('lex C6 — sem contexto de auth, a escrita é RECUSADA (500)', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const repo = { unmark: jest.fn(), getRef: jest.fn() };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.unmark(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(repo.unmark).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-cru'],
    ])('500 em erro inesperado — quando a rejeição %s', async (_label, rejeicao) => {
      const repo = { unmark: jest.fn().mockRejectedValue(rejeicao), getRef: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientEmergencyContactController(repo as never, db() as never);
      const res = mockRes();
      await controller.unmark(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
