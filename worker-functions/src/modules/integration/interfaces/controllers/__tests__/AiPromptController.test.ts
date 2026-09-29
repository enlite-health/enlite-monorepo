/**
 * AiPromptController.test.ts (spec 029, T012/T019b)
 *
 * Molde: `AdminTherapeuticProjectsController.test.ts` — use cases FALSOS injetados no
 * construtor, `cellsOfRequest` REAL (só lê `req.permissionCells`, D113: `cells === null` libera).
 *
 * Um teste por código de resposta do contrato (`contracts/admin-ai-prompts.md`): 200, 400, 403,
 * 404, 409, 422 (este último só em `undo`). `restore`/`preview` são de fases posteriores — não
 * existem neste controller.
 */

jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  loggingAls: { getStore: jest.fn().mockReturnValue(null) },
}));

import type { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AiPromptController } from '../AiPromptController';
import { GetAiPromptUseCase, type GetAiPromptOutput } from '../../../application/GetAiPromptUseCase';
import { UpdateAiPromptUseCase, type UpdateAiPromptResult } from '../../../application/UpdateAiPromptUseCase';
import { UndoAiPromptUseCase, type UndoAiPromptResult } from '../../../application/UndoAiPromptUseCase';
import type { AiPrompt } from '../../../infrastructure/AiPromptRepository';

// ── Helpers ───────────────────────────────────────────────────────

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return { params: {}, body: {}, query: {}, ...overrides } as unknown as Request;
}

function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

const corpoDaResposta = (res: { json: jest.Mock }) => res.json.mock.calls[0][0];

/** Os três use cases, sempre como dublê — nenhum teste toca o pool de verdade. */
function ctrl(
  get: Partial<GetAiPromptUseCase> = {},
  update: Partial<UpdateAiPromptUseCase> = {},
  undo: Partial<UndoAiPromptUseCase> = {},
): AiPromptController {
  const getUseCase = { execute: jest.fn(), list: jest.fn(), ...get } as unknown as GetAiPromptUseCase;
  const updateUseCase = { execute: jest.fn(), ...update } as unknown as UpdateAiPromptUseCase;
  const undoUseCase = { execute: jest.fn(), ...undo } as unknown as UndoAiPromptUseCase;
  return new AiPromptController(getUseCase, updateUseCase, undoUseCase);
}

const PROMPT: AiPrompt = {
  slug: 'VACANCY_DESCRIPTION',
  body: 'Texto do prompt de vaga.',
  version: 7,
  isActive: true,
  createdBy: 'uid-criador',
  updatedBy: 'uid-abc',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-29T12:00:00.000Z',
};

const PROMPT_NO_FORMATO_DO_CONTRATO = {
  slug: 'VACANCY_DESCRIPTION',
  body: 'Texto do prompt de vaga.',
  version: 7,
  updatedBy: 'uid-abc',
  updatedAt: '2026-09-29T12:00:00.000Z',
  isActive: true,
};

describe('AiPromptController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('list — GET /api/admin/ai-prompts', () => {
    it('200: lista os prompts no formato do contrato ({slug,body,version,updatedBy,updatedAt,isActive})', async () => {
      const list = jest.fn().mockResolvedValue([PROMPT]);
      const res = mockRes();

      await ctrl({ list }).list(mockReq({ permissionCells: ['ai_prompt:read'] }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(corpoDaResposta(res)).toEqual({ data: [PROMPT_NO_FORMATO_DO_CONTRATO] });
    });

    it('cells = null (D113, engine não decidiu) libera a listagem', async () => {
      const list = jest.fn().mockResolvedValue([PROMPT]);
      const res = mockRes();

      await ctrl({ list }).list(mockReq({ permissionCells: undefined }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(list).toHaveBeenCalled();
    });

    it('403 sem `ai_prompt:read`: nem chama o use case', async () => {
      const list = jest.fn();
      const res = mockRes();

      await ctrl({ list }).list(mockReq({ permissionCells: [] }), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, details: { cell: 'ai_prompt:read' } }),
      );
      expect(list).not.toHaveBeenCalled();
    });

    it('500 e reporta o erro quando o use case lança', async () => {
      const list = jest.fn().mockRejectedValue(new Error('db indisponível'));
      const res = mockRes();

      await ctrl({ list }).list(mockReq({ permissionCells: ['ai_prompt:read'] }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalled();
    });

    it('500 quando o use case lança algo que NÃO é Error (ex.: string crua) — vira new Error(String(...)) antes de reportar', async () => {
      const list = jest.fn().mockRejectedValue('falha crua, não é Error');
      const res = mockRes();

      await ctrl({ list }).list(mockReq({ permissionCells: ['ai_prompt:read'] }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      const [erroReportado] = (reportError as jest.Mock).mock.calls[0];
      expect(erroReportado).toBeInstanceOf(Error);
      expect(erroReportado.message).toBe('falha crua, não é Error');
    });
  });

  describe('get — GET /api/admin/ai-prompts/{slug}', () => {
    it('200: devolve o prompt no formato do contrato', async () => {
      const execute = jest.fn().mockResolvedValue({ found: true, prompt: PROMPT } satisfies GetAiPromptOutput);
      const res = mockRes();

      await ctrl({ execute }).get(
        mockReq({ params: { slug: 'VACANCY_DESCRIPTION' }, permissionCells: ['ai_prompt:read'] }),
        res,
      );

      expect(execute).toHaveBeenCalledWith('VACANCY_DESCRIPTION');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(corpoDaResposta(res)).toEqual({ data: PROMPT_NO_FORMATO_DO_CONTRATO });
    });

    it('404: slug desconhecido ou sem linha — o use case colapsa os dois em found:false', async () => {
      const execute = jest.fn().mockResolvedValue({ found: false } satisfies GetAiPromptOutput);
      const res = mockRes();

      await ctrl({ execute }).get(
        mockReq({ params: { slug: 'NAO_EXISTE' }, permissionCells: ['ai_prompt:read'] }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, error: 'ai_prompt_nao_encontrado' }),
      );
    });

    it('403 sem `ai_prompt:read`: nem chama o use case', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl({ execute }).get(
        mockReq({ params: { slug: 'VACANCY_DESCRIPTION' }, permissionCells: ['ai_prompt:update'] }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(execute).not.toHaveBeenCalled();
    });

    it('500 e reporta o erro quando o use case lança', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('db indisponível'));
      const res = mockRes();

      await ctrl({ execute }).get(
        mockReq({ params: { slug: 'VACANCY_DESCRIPTION' }, permissionCells: ['ai_prompt:read'] }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, error: 'Failed to get ai prompt' }),
      );
      expect(reportError).toHaveBeenCalled();
    });

    it('500 quando o use case lança algo que NÃO é Error (ex.: string crua) — vira new Error(String(...)) antes de reportar', async () => {
      const execute = jest.fn().mockRejectedValue('falha crua, não é Error');
      const res = mockRes();

      await ctrl({ execute }).get(
        mockReq({ params: { slug: 'VACANCY_DESCRIPTION' }, permissionCells: ['ai_prompt:read'] }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      const [erroReportado] = (reportError as jest.Mock).mock.calls[0];
      expect(erroReportado).toBeInstanceOf(Error);
      expect(erroReportado.message).toBe('falha crua, não é Error');
    });
  });

  describe('update — PUT /api/admin/ai-prompts/{slug}', () => {
    it('200: grava e devolve o registro com a version já incrementada', async () => {
      const atualizado: AiPrompt = { ...PROMPT, version: 8, body: 'Texto novo.' };
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'updated', prompt: atualizado } satisfies UpdateAiPromptResult);
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: ['ai_prompt:update'],
          user: { uid: 'uid-editor' },
        }),
        res,
      );

      expect(execute).toHaveBeenCalledWith(
        { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', expectedVersion: 7 },
        expect.objectContaining({ actorUserId: 'uid-editor', actorType: 'HUMAN' }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(corpoDaResposta(res)).toEqual({
        data: { slug: 'VACANCY_DESCRIPTION', body: 'Texto novo.', version: 8, updatedBy: 'uid-abc', updatedAt: PROMPT.updatedAt, isActive: true },
      });
    });

    it('400: body vazio (só espaços) é recusado pelo schema — o use case nem é chamado', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: '   ', version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('req.body ausente (undefined) cai no fallback {} antes do parse — schema recusa com 400, sem lançar', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: undefined,
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('400: use case devolve outcome invalid (defesa redundante atrás do schema) — corpo_vazio', async () => {
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'invalid', reason: 'empty_body' } satisfies UpdateAiPromptResult);
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(execute).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual(expect.objectContaining({ success: false, error: 'body_vazio' }));
    });

    it('cells = null (D113, engine não decidiu) libera a escrita — mesma regra de canReadAiPrompt, espelhada para update', async () => {
      const atualizado: AiPrompt = { ...PROMPT, version: 8, body: 'Texto novo.' };
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'updated', prompt: atualizado } satisfies UpdateAiPromptResult);
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: undefined,
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(execute).toHaveBeenCalled();
    });

    it('403 sem `ai_prompt:update`: nem o slug é conferido nem o use case é chamado', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: ['ai_prompt:read'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, details: { cell: 'ai_prompt:update' } }),
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('404: slug fora do conjunto fechado — nem chama o use case (mesma regra do contrato: recurso não existe)', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'NAO_EXISTE' },
          body: { body: 'Texto novo.', version: 1 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(execute).not.toHaveBeenCalled();
    });

    it('404: use case devolve not_found (slug válido, sem linha na tabela)', async () => {
      const execute = jest.fn().mockResolvedValue({ outcome: 'not_found' } satisfies UpdateAiPromptResult);
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'PRESCREENING_AT' },
          body: { body: 'Texto novo.', version: 1 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, error: 'ai_prompt_nao_encontrado' }),
      );
    });

    it('409: version divergente — devolve a version atual e quem gravou por último, nada é gravado', async () => {
      const execute = jest.fn().mockResolvedValue({
        outcome: 'conflict',
        currentVersion: 9,
        updatedBy: 'uid-outra-pessoa',
      } satisfies UpdateAiPromptResult);
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(409);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, error: 'version_conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' }),
      );
    });

    it('sem `req.user.uid`: ator cai para SYSTEM/admin_panel (nunca HUMAN sem uid)', async () => {
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'updated', prompt: PROMPT } satisfies UpdateAiPromptResult);
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actorUserId: null, actorType: 'SYSTEM', actorLabel: 'admin_panel' }),
      );
    });

    it('500 e reporta o erro quando o use case lança', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('db indisponível'));
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalled();
    });

    it('500 quando o use case lança algo que NÃO é Error (ex.: string crua) — vira new Error(String(...)) antes de reportar', async () => {
      const execute = jest.fn().mockRejectedValue('falha crua, não é Error');
      const res = mockRes();

      await ctrl(
        {},
        { execute },
      ).update(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { body: 'Texto novo.', version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      const [erroReportado] = (reportError as jest.Mock).mock.calls[0];
      expect(erroReportado).toBeInstanceOf(Error);
      expect(erroReportado.message).toBe('falha crua, não é Error');
    });
  });

  describe('undo — POST /api/admin/ai-prompts/{slug}/undo', () => {
    it('200: desfaz e devolve o registro com o conteúdo imediatamente anterior e a version incrementada', async () => {
      const restaurado: AiPrompt = { ...PROMPT, version: 8, body: 'Texto antigo (o que volta a valer).' };
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'restored', prompt: restaurado } satisfies UndoAiPromptResult);
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 7 },
          permissionCells: ['ai_prompt:update'],
          user: { uid: 'uid-editor' },
        }),
        res,
      );

      expect(execute).toHaveBeenCalledWith(
        { slug: 'VACANCY_DESCRIPTION', expectedVersion: 7 },
        expect.objectContaining({ actorUserId: 'uid-editor', actorType: 'HUMAN' }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(corpoDaResposta(res)).toEqual({
        data: {
          slug: 'VACANCY_DESCRIPTION',
          body: 'Texto antigo (o que volta a valer).',
          version: 8,
          updatedBy: 'uid-abc',
          updatedAt: PROMPT.updatedAt,
          isActive: true,
        },
      });
    });

    it('400: version ausente/não-inteira é recusada pelo schema — o use case nem é chamado', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: {},
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('req.body ausente (undefined) cai no fallback {} antes do parse — schema recusa com 400, sem lançar', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: undefined,
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('403 sem `ai_prompt:update`: nem o slug é conferido nem o use case é chamado', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 7 },
          permissionCells: ['ai_prompt:read'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, details: { cell: 'ai_prompt:update' } }),
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('404: slug fora do conjunto fechado — nem chama o use case', async () => {
      const execute = jest.fn();
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'NAO_EXISTE' },
          body: { version: 1 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(execute).not.toHaveBeenCalled();
    });

    it('404: use case devolve not_found (slug válido, sem linha na tabela)', async () => {
      const execute = jest.fn().mockResolvedValue({ outcome: 'not_found' } satisfies UndoAiPromptResult);
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'PRESCREENING_AT' },
          body: { version: 1 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, error: 'ai_prompt_nao_encontrado' }),
      );
    });

    it('409: version divergente — devolve a version atual e quem gravou por último, nada é gravado', async () => {
      const execute = jest.fn().mockResolvedValue({
        outcome: 'conflict',
        currentVersion: 9,
        updatedBy: 'uid-outra-pessoa',
      } satisfies UndoAiPromptResult);
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(409);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, error: 'version_conflict', currentVersion: 9, updatedBy: 'uid-outra-pessoa' }),
      );
    });

    it('422: sem versão anterior (primeiro conteúdo) — a tela desabilita o botão antes disso, mas o servidor recusa sempre', async () => {
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'no_previous_version' } satisfies UndoAiPromptResult);
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 1 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(422);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, error: 'sem_versao_anterior' }),
      );
    });

    it('cells = null (D113, engine não decidiu) libera o desfazer — mesma regra de canUpdateAiPrompt', async () => {
      const restaurado: AiPrompt = { ...PROMPT, version: 8, body: 'Texto antigo.' };
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'restored', prompt: restaurado } satisfies UndoAiPromptResult);
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 7 },
          permissionCells: undefined,
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(200);
      expect(execute).toHaveBeenCalled();
    });

    it('sem `req.user.uid`: ator cai para SYSTEM/admin_panel (nunca HUMAN sem uid)', async () => {
      const execute = jest
        .fn()
        .mockResolvedValue({ outcome: 'restored', prompt: PROMPT } satisfies UndoAiPromptResult);
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actorUserId: null, actorType: 'SYSTEM', actorLabel: 'admin_panel' }),
      );
    });

    it('500 e reporta o erro quando o use case lança', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('db indisponível'));
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalled();
    });

    it('500 quando o use case lança algo que NÃO é Error (ex.: string crua) — vira new Error(String(...)) antes de reportar', async () => {
      const execute = jest.fn().mockRejectedValue('falha crua, não é Error');
      const res = mockRes();

      await ctrl({}, {}, { execute }).undo(
        mockReq({
          params: { slug: 'VACANCY_DESCRIPTION' },
          body: { version: 7 },
          permissionCells: ['ai_prompt:update'],
        }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      const [erroReportado] = (reportError as jest.Mock).mock.calls[0];
      expect(erroReportado).toBeInstanceOf(Error);
      expect(erroReportado.message).toBe('falha crua, não é Error');
    });
  });

  describe('Construtor sem use cases injetados (linhas 81-83)', () => {
    // Mesmo motivo do teste equivalente em UpdateAiPromptUseCase.test.ts: o default do 3º
    // parâmetro de UpdateAiPromptUseCase/UndoAiPromptUseCase chama
    // DatabaseConnection.getInstance().getPool(), que exige DATABASE_URL/DB_HOST no ambiente.
    // `pg.Pool` só conecta de verdade em `.connect()`/`.query()`, nunca no construtor —
    // DATABASE_URL falso, setado e restaurado só aqui, não toca rede nenhuma.
    const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

    afterAll(() => {
      if (ORIGINAL_DATABASE_URL === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
      }
    });

    it('usa GetAiPromptUseCase, UpdateAiPromptUseCase e UndoAiPromptUseCase reais quando nenhum use case é passado', () => {
      process.env.DATABASE_URL = 'postgres://fake-para-teste-de-construtor/db';

      const controller = new AiPromptController();
      const internals = controller as unknown as { getUseCase: unknown; updateUseCase: unknown; undoUseCase: unknown };

      expect(internals.getUseCase).toBeInstanceOf(GetAiPromptUseCase);
      expect(internals.updateUseCase).toBeInstanceOf(UpdateAiPromptUseCase);
      expect(internals.undoUseCase).toBeInstanceOf(UndoAiPromptUseCase);
    });
  });
});
