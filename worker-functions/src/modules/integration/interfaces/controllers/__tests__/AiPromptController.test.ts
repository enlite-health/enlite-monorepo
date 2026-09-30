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
import {
  PreviewAiPromptUseCase,
  PreviewEmptyBodyError,
  JobPostingNotFoundError,
} from '../../../application/PreviewAiPromptUseCase';
import { SimulateVacancyAiUseCase } from '../../../application/SimulateVacancyAiUseCase';
import { GeminiApiError } from '../../../infrastructure/gemini-fetch';
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
  preview: Partial<PreviewAiPromptUseCase> = {},
  simulate: Partial<SimulateVacancyAiUseCase> = {},
): AiPromptController {
  const getUseCase = { execute: jest.fn(), list: jest.fn(), ...get } as unknown as GetAiPromptUseCase;
  const updateUseCase = { execute: jest.fn(), ...update } as unknown as UpdateAiPromptUseCase;
  const undoUseCase = { execute: jest.fn(), ...undo } as unknown as UndoAiPromptUseCase;
  const previewUseCase = { execute: jest.fn(), ...preview } as unknown as PreviewAiPromptUseCase;
  const simulateUseCase = { execute: jest.fn(), ...simulate } as unknown as SimulateVacancyAiUseCase;
  return new AiPromptController(getUseCase, updateUseCase, undoUseCase, previewUseCase, simulateUseCase);
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
      expect(corpoDaResposta(res)).toEqual({ success: true, data: [PROMPT_NO_FORMATO_DO_CONTRATO] });
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
      expect(corpoDaResposta(res)).toEqual({ success: true, data: PROMPT_NO_FORMATO_DO_CONTRATO });
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
        success: true,
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
        success: true,
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

  describe('preview — POST /api/admin/ai-prompts/{slug}/preview (T033)', () => {
    const JOB_ID = '3f2b1c9e-8d4a-4e6b-9a1f-0c5d7e2a4b61';
    const OUTPUT = { jobPostingId: JOB_ID, slug: 'VACANCY_DESCRIPTION', generated: 'texto gerado' };
    const reqPreview = (over: Record<string, unknown> = {}) =>
      mockReq({
        params: { slug: 'VACANCY_DESCRIPTION' },
        body: { body: 'texto em edição', jobPostingId: JOB_ID },
        permissionCells: ['ai_prompt:update'],
        ...over,
      });

    it('200: corpo é EXATAMENTE { success: true, data: { jobPostingId, slug, generated } } — a junta com request() do front', async () => {
      const execute = jest.fn().mockResolvedValue(OUTPUT);
      const res = mockRes();

      await ctrl({}, {}, {}, { execute }).preview(reqPreview(), res);

      expect(res.status).toHaveBeenCalledWith(200);
      const corpo = corpoDaResposta(res);
      expect(corpo.success).toBe(true);
      expect(corpo).toEqual({ success: true, data: OUTPUT });
      expect(execute).toHaveBeenCalledWith({
        slug: 'VACANCY_DESCRIPTION', body: 'texto em edição', jobPostingId: JOB_ID,
      });
    });

    it('400: body só com espaços — não chama o use case', async () => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview({ body: { body: '   ', jobPostingId: JOB_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual(expect.objectContaining({ success: false }));
      expect(execute).not.toHaveBeenCalled();
    });

    it('400: body ausente', async () => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview({ body: { jobPostingId: JOB_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('400: jobPostingId ausente', async () => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview({ body: { body: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('400: jobPostingId que não é UUID', async () => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview({ body: { body: 'x', jobPostingId: 'abc' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('400: PreviewEmptyBodyError vinda do use case (defesa redundante)', async () => {
      const execute = jest.fn().mockRejectedValue(new PreviewEmptyBodyError());
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview(), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('403 sem `ai_prompt:update` (só `read` não basta): não chama o use case', async () => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview({ permissionCells: ['ai_prompt:read'] }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual(
        expect.objectContaining({ success: false, details: { cell: 'ai_prompt:update' } }),
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('cells = null (D113) libera', async () => {
      const execute = jest.fn().mockResolvedValue(OUTPUT);
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview({ permissionCells: undefined }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('404: slug fora do conjunto fechado (não 400)', async () => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview({ params: { slug: 'NAO_EXISTE' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(execute).not.toHaveBeenCalled();
    });

    it('404: caso inexistente (JobPostingNotFoundError)', async () => {
      const execute = jest.fn().mockRejectedValue(new JobPostingNotFoundError(JOB_ID));
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview(), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toEqual(expect.objectContaining({ success: false }));
    });

    it('503: modelo indisponível (GeminiApiError) — sem chamar Vertex de verdade', async () => {
      const execute = jest.fn().mockRejectedValue(new GeminiApiError(503, 'unavailable'));
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview(), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'modelo_indisponivel' });
    });

    it('503: sem token ADC do Vertex (erro dublado no use case)', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('Vertex AI: could not obtain an ADC access token'));
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview(), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('500: erro inesperado — reporta', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('boom'));
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalled();
    });

    it('500: lançamento que NÃO é Error vira Error antes de reportar', async () => {
      const execute = jest.fn().mockRejectedValue('crua');
      const res = mockRes();
      await ctrl({}, {}, {}, { execute }).preview(reqPreview(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });


  describe('simulateVacancy — POST /api/admin/ai-prompts/simulate-vacancy (T071)', () => {
    const JOB_ID = '3f2b1c9e-8d4a-4e6b-9a1f-0c5d7e2a4b61';
    const OUTPUT = {
      description: 'texto',
      prescreening: { questions: [], faq: [] },
      workerType: 'AT',
      usedSlugs: ['VACANCY_DESCRIPTION', 'PRESCREENING_AT'],
    };
    const reqSim = (over: Record<string, unknown> = {}) =>
      mockReq({
        body: { jobPostingId: JOB_ID, bodies: { PRESCREENING_AT: 'em edição' } },
        permissionCells: ['ai_prompt:update'],
        ...over,
      });

    it('200: corpo é EXATAMENTE { success: true, data } — a junta com request() do front', async () => {
      const execute = jest.fn().mockResolvedValue(OUTPUT);
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim(), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(corpoDaResposta(res).success).toBe(true);
      expect(corpoDaResposta(res)).toEqual({ success: true, data: OUTPUT });
      expect(execute).toHaveBeenCalledWith({ jobPostingId: JOB_ID, bodies: { PRESCREENING_AT: 'em edição' } });
    });

    it('bodies ausente vira {} (corpo ausente = prompt salvo)', async () => {
      const execute = jest.fn().mockResolvedValue(OUTPUT);
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim({ body: { jobPostingId: JOB_ID } }), mockRes());
      expect(execute).toHaveBeenCalledWith({ jobPostingId: JOB_ID, bodies: {} });
    });

    it.each([
      ['jobPostingId não é UUID', { jobPostingId: 'x', bodies: {} }],
      ['corpo só com espaços', { jobPostingId: JOB_ID, bodies: { VACANCY_DESCRIPTION: '   ' } }],
      ['slug desconhecido em bodies', { jobPostingId: JOB_ID, bodies: { OUTRO: 'x' } }],
      ['campo extra', { jobPostingId: JOB_ID, bodies: {}, extra: 1 }],
    ])('400: %s — não chama o use case', async (_n, body) => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim({ body }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('403 sem `ai_prompt:update`: não chama o use case', async () => {
      const execute = jest.fn();
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim({ permissionCells: ['ai_prompt:read'] }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(execute).not.toHaveBeenCalled();
    });

    it('cells = null (D113) libera', async () => {
      const execute = jest.fn().mockResolvedValue(OUTPUT);
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim({ permissionCells: null }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('404: caso inexistente', async () => {
      const execute = jest.fn().mockRejectedValue(new JobPostingNotFoundError(JOB_ID));
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim(), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'caso_nao_encontrado' });
    });

    it('503: modelo indisponível', async () => {
      const execute = jest.fn().mockRejectedValue(new GeminiApiError(503, 'unavailable'));
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim(), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'modelo_indisponivel' });
    });

    it('503: sem token ADC do Vertex', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('Vertex AI: no token'));
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute }).simulateVacancy(reqSim(), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('500: erro inesperado — reporta; lançamento que não é Error vira Error', async () => {
      const res = mockRes();
      await ctrl({}, {}, {}, {}, { execute: jest.fn().mockRejectedValue('boom') }).simulateVacancy(reqSim(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AiPromptController:simulateVacancy' });
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
      const internals = controller as unknown as {
        getUseCase: unknown; updateUseCase: unknown; undoUseCase: unknown; previewUseCase: unknown; simulateUseCase: unknown;
      };

      expect(internals.getUseCase).toBeInstanceOf(GetAiPromptUseCase);
      expect(internals.updateUseCase).toBeInstanceOf(UpdateAiPromptUseCase);
      expect(internals.undoUseCase).toBeInstanceOf(UndoAiPromptUseCase);
      expect(internals.previewUseCase).toBeInstanceOf(PreviewAiPromptUseCase);
      expect(internals.simulateUseCase).toBeInstanceOf(SimulateVacancyAiUseCase);
    });
  });
});
