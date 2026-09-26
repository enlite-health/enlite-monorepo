/**
 * VacancyNotesController.test.ts
 *
 * Cenários:
 * 1. create — 201 com corpo quando o use case aceita
 * 2. create — 400 quando o use case devolve validation (categoria inválida)
 * 3. create — 404 quando o use case devolve not_found (vaga inexistente)
 * 4. create — 401 sem req.user
 * 5. list — 200 com data; 404 em not_found
 * 6. perímetro (critério 12) — nenhuma linha de `logger.` carrega o texto livre
 *    (`body`/`contact`) semeado na chamada
 */

const mockList = jest.fn();
const mockCreate = jest.fn();

jest.mock('../../../application/VacancyNotesUseCase', () => ({
  VacancyNotesUseCase: jest.fn().mockImplementation(() => ({
    list: mockList,
    create: mockCreate,
  })),
}));

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

import { VacancyNotesController } from '../VacancyNotesController';
import { logger } from '@shared/logging';
import { Request, Response } from 'express';

const VACANCY_ID = 'bbbbbbbb-0000-0000-0000-222222222222';
const DEFAULT_USER = { uid: 'uid-1', email: 'operadora@enlite.health' };

function mockReqRes(
  params: Record<string, string> = {},
  body: Record<string, unknown> = {},
  user: { uid?: string; email?: string } | null = DEFAULT_USER,
): [Request, Response] {
  const req = { params, body, user: user ?? undefined } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('VacancyNotesController', () => {
  let controller: VacancyNotesController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new VacancyNotesController();
  });

  describe('create', () => {
    it('201 com corpo quando o use case aceita', async () => {
      mockCreate.mockResolvedValueOnce({
        ok: true,
        note: { id: 'n1', jobPostingId: VACANCY_ID, category: 'DIVULGACAO' },
      });

      const [req, res] = mockReqRes({ id: VACANCY_ID }, { category: 'DIVULGACAO' });
      await controller.create(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { id: 'n1', jobPostingId: VACANCY_ID, category: 'DIVULGACAO' },
      });
    });

    it('400 quando o use case devolve validation', async () => {
      mockCreate.mockResolvedValueOnce({ ok: false, error: { kind: 'validation', message: 'categoria inválida' } });

      const [req, res] = mockReqRes({ id: VACANCY_ID }, { category: 'BLOQUEADO' });
      await controller.create(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 quando o use case devolve not_found', async () => {
      mockCreate.mockResolvedValueOnce({ ok: false, error: { kind: 'not_found', message: 'vaga não encontrada' } });

      const [req, res] = mockReqRes({ id: VACANCY_ID }, { category: 'DIVULGACAO' });
      await controller.create(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('401 sem req.user', async () => {
      const [req, res] = mockReqRes({ id: VACANCY_ID }, { category: 'DIVULGACAO' }, null);
      await controller.create(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('perímetro: nenhuma linha de logger. carrega o texto livre semeado', async () => {
      const TEXTO_LIVRE = 'ligou pro coordenador às 14h pedindo retorno';
      const QUEM = 'grupo Facebook Recrutamento AT';

      mockCreate.mockResolvedValueOnce({
        ok: true,
        note: { id: 'n1', jobPostingId: VACANCY_ID, category: 'CONTATO', contact: QUEM, body: TEXTO_LIVRE },
      });

      const [req, res] = mockReqRes({ id: VACANCY_ID }, { category: 'CONTATO', contact: QUEM, body: TEXTO_LIVRE });
      await controller.create(req, res);

      const chamadasDoLogger = JSON.stringify(jest.mocked(logger.info).mock.calls);
      expect(chamadasDoLogger).not.toContain(TEXTO_LIVRE);
      expect(chamadasDoLogger).not.toContain(QUEM);
    });
  });

  describe('list', () => {
    it('200 com data', async () => {
      mockList.mockResolvedValueOnce({ ok: true, notes: [{ id: 'n1' }] });

      const [req, res] = mockReqRes({ id: VACANCY_ID });
      await controller.list(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ id: 'n1' }] });
    });

    it('404 em not_found', async () => {
      mockList.mockResolvedValueOnce({ ok: false, error: { kind: 'not_found', message: 'vaga não encontrada' } });

      const [req, res] = mockReqRes({ id: VACANCY_ID });
      await controller.list(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
