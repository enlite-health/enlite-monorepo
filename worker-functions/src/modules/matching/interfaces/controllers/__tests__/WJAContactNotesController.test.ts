/**
 * WJAContactNotesController.test.ts
 *
 * Migration 236: rota re-chaveada para SÓ :vacancyId (removido o segmento
 * /workers/:workerId). Controller lê apenas req.params.vacancyId e repassa
 * vacancyId (sem workerId) pros use cases — a nota é escopada à VAGA inteira,
 * não a um par candidato×vaga.
 *
 * Cenários:
 * 1. create — 401 sem user
 * 2. create — 400 noteText não-string
 * 3. create — repassa vacancyId (sem workerId) pro use case
 * 4. create — 404 quando use case retorna not_found
 * 5. list — repassa vacancyId pro use case; 404 em not_found
 * 6. delete — repassa vacancyId pro use case; 403 em forbidden com reason
 */

const mockCreateExecute = jest.fn();
const mockListExecute = jest.fn();
const mockDeleteExecute = jest.fn();

jest.mock('../../../application/CreateContactNoteUseCase', () => ({
  CreateContactNoteUseCase: jest.fn().mockImplementation(() => ({ execute: mockCreateExecute })),
}));
jest.mock('../../../application/ListContactNotesUseCase', () => ({
  ListContactNotesUseCase: jest.fn().mockImplementation(() => ({ execute: mockListExecute })),
}));
jest.mock('../../../application/DeleteContactNoteUseCase', () => ({
  DeleteContactNoteUseCase: jest.fn().mockImplementation(() => ({ execute: mockDeleteExecute })),
}));

import { WJAContactNotesController } from '../WJAContactNotesController';
import { Request, Response } from 'express';

const VACANCY_ID = 'bbbb0000-0000-0000-0000-222222222222';

const DEFAULT_USER = { uid: 'admin-1', email: 'admin@e2e.local' };

// Nota: `user` usa sentinel (não default param) porque passar `undefined`
// explicitamente pro parâmetro acionaria o default de qualquer forma
// (semântica de JS) — precisamos distinguir "sem argumento" de "sem user".
function mockReqRes(
  params: Record<string, string> = {},
  body: Record<string, unknown> = {},
  user: { uid: string; email?: string } | null = DEFAULT_USER,
): [Request, Response] {
  const req = { params, body, user: user ?? undefined } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('WJAContactNotesController', () => {
  let controller: WJAContactNotesController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new WJAContactNotesController();
  });

  describe('create', () => {
    it('401 quando não há user autenticado', async () => {
      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID }, { noteText: 'x' }, null);
      await controller.create(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('400 quando noteText não é string', async () => {
      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID }, { noteText: 42 });
      await controller.create(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockCreateExecute).not.toHaveBeenCalled();
    });

    it('repassa vacancyId (sem workerId) pro use case', async () => {
      mockCreateExecute.mockResolvedValueOnce({
        ok: true,
        note: {
          id: 'note-1',
          jobPostingId: VACANCY_ID,
          noteText: 'Nota',
          createdByAdminId: 'admin-1',
          createdByAdminName: null,
          createdByAdminEmail: null,
          createdAt: new Date().toISOString(),
        },
      });

      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID }, { noteText: 'Nota' });
      await controller.create(req, res);

      expect(mockCreateExecute).toHaveBeenCalledWith(
        expect.objectContaining({ vacancyId: VACANCY_ID, noteText: 'Nota', adminId: 'admin-1' }),
      );
      const callArgs = mockCreateExecute.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('workerId');
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('404 quando use case retorna not_found (vaga não existe)', async () => {
      mockCreateExecute.mockResolvedValueOnce({
        ok: false,
        error: { kind: 'not_found', message: 'não encontrado' },
      });

      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID }, { noteText: 'Nota' });
      await controller.create(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('list', () => {
    it('repassa vacancyId pro use case', async () => {
      mockListExecute.mockResolvedValueOnce({ ok: true, notes: [] });

      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID });
      await controller.list(req, res);

      expect(mockListExecute).toHaveBeenCalledWith(
        expect.objectContaining({ vacancyId: VACANCY_ID, requesterAdminId: 'admin-1' }),
      );
      const callArgs = mockListExecute.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('workerId');
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
    });

    it('404 quando use case retorna not_found', async () => {
      mockListExecute.mockResolvedValueOnce({ ok: false, error: { kind: 'not_found', message: 'x' } });

      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID });
      await controller.list(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('delete', () => {
    it('repassa vacancyId pro use case; 403 com reason em forbidden', async () => {
      mockDeleteExecute.mockResolvedValueOnce({
        ok: false,
        error: { kind: 'forbidden', reason: 'not_owner', message: 'Só o autor pode excluir' },
      });

      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID, noteId: 'note-1' });
      await controller.delete(req, res);

      expect(mockDeleteExecute).toHaveBeenCalledWith(
        expect.objectContaining({ vacancyId: VACANCY_ID, noteId: 'note-1', requesterAdminId: 'admin-1' }),
      );
      const callArgs = mockDeleteExecute.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('workerId');
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'not_owner' }));
    });

    it('sucesso — 200 com id da nota excluída', async () => {
      mockDeleteExecute.mockResolvedValueOnce({ ok: true });

      const [req, res] = mockReqRes({ vacancyId: VACANCY_ID, noteId: 'note-1' });
      await controller.delete(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'note-1' } });
    });
  });
});
