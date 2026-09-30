/**
 * AiPromptController — leitura e escrita dos prompts de IA editáveis (spec 029, T012/T019b).
 *
 * Cobre quatro manipuladores (contrato `contracts/admin-ai-prompts.md`):
 *   GET  /api/admin/ai-prompts             → `list`
 *   GET  /api/admin/ai-prompts/{slug}      → `get`
 *   PUT  /api/admin/ai-prompts/{slug}      → `update`
 *   POST /api/admin/ai-prompts/{slug}/undo → `undo`
 *
 * A sub-rota de restaurar uma versão arbitrária e a de pré-visualizar são de fases posteriores
 * (Fase 4 e Fase 5) — não entram aqui.
 *
 * Zero lógica de negócio: `GetAiPromptUseCase`, `UpdateAiPromptUseCase` (T009/T010) e
 * `UndoAiPromptUseCase` (T019b) já decidem tudo. Este arquivo só faz HTTP — parse de entrada,
 * checagem de célula, código de resposta.
 *
 * 🔒 Célula (`ai_prompt:read`/`ai_prompt:update`), verificada AQUI, e não só na rota (T013): mesmo
 * padrão de `AdminTherapeuticProjectsController` (lex C7) — `cellsOfRequest(req)` +
 * `req.permissionCells`, nunca reimplementado. `cells === null` deixa passar (D113: engine ainda
 * não decidiu para esta família/rota — não é "sem célula nenhuma", que seria `[]`).
 *
 * `undo` exige `ai_prompt:update` — a MESMA célula de quem salvou (contrato: "a mesma de quem
 * salvou"), nunca `ai_prompt:restore` (essa é só da Fase 5, para o alvo arbitrário).
 *
 * Slug fora do conjunto fechado (`AI_PROMPT_SLUGS`) é **404, nunca 400** — o contrato manda (o
 * recurso é que não existe). Por isso `get` delega a decisão inteira a `GetAiPromptUseCase.execute`
 * (que já colapsa "identificador desconhecido" e "sem linha" no mesmo `found:false`), e `update`/
 * `undo` conferem com `isAiPromptSlug` antes de chamar o caso de uso, que exige o tipo estreito
 * `AiPromptSlug` e não aceita string crua.
 */

import type { Request, Response } from 'express';
import { cellsOfRequest } from '@modules/identity/permissions';
import { reportError, loggingAls } from '@shared/logging';
import { GetAiPromptUseCase } from '../../application/GetAiPromptUseCase';
import { UpdateAiPromptUseCase, type UpdateAiPromptActor } from '../../application/UpdateAiPromptUseCase';
import { UndoAiPromptUseCase } from '../../application/UndoAiPromptUseCase';
import type { AiPrompt } from '../../infrastructure/AiPromptRepository';
import { isAiPromptSlug } from '../../domain/AiPromptSlug';
import { updateAiPromptBodySchema, undoAiPromptBodySchema } from '../validators/aiPromptSchemas';

const AI_PROMPT_READ_CELL = 'ai_prompt:read';
const AI_PROMPT_UPDATE_CELL = 'ai_prompt:update';

/** `cells === null` (D113: engine não decidiu para esta rota/família) deixa passar. */
function canReadAiPrompt(cells: readonly string[] | null): boolean {
  if (cells === null) return true;
  return cells.includes(AI_PROMPT_READ_CELL);
}

function canUpdateAiPrompt(cells: readonly string[] | null): boolean {
  if (cells === null) return true;
  return cells.includes(AI_PROMPT_UPDATE_CELL);
}

/** Formato de resposta do contrato: `{slug, body, version, updatedBy, updatedAt, isActive}`. */
function toApiPrompt(p: AiPrompt): Record<string, unknown> {
  return {
    slug: p.slug,
    body: p.body,
    version: p.version,
    updatedBy: p.updatedBy,
    updatedAt: p.updatedAt,
    isActive: p.isActive,
  };
}

/**
 * Ator de quem grava, derivado da request autenticada — mesmo padrão de
 * `vacancyCrudAuditHelpers.vacancyActorFromRequest`: com `uid`, é sempre `'HUMAN'`; sem `uid`
 * (chamada sem operador humano no painel, o que a auth admin já deveria ter barrado antes daqui),
 * cai para `'SYSTEM'` com `actorLabel` preenchido — a migration 485 exige um dos dois conforme o
 * `actorType` (`UpdateAiPromptUseCase.ts`), e `'SYSTEM'` sem `actorLabel` violaria essa CHECK.
 */
function actorFromRequest(req: Request): UpdateAiPromptActor {
  const uid = (req as Request & { user?: { uid?: string } }).user?.uid ?? null;
  return {
    actorUserId: uid,
    actorType: uid ? 'HUMAN' : 'SYSTEM',
    actorLabel: uid ? null : 'admin_panel',
    traceId: loggingAls.getStore()?.traceId ?? null,
  };
}

export class AiPromptController {
  constructor(
    private readonly getUseCase: GetAiPromptUseCase = new GetAiPromptUseCase(),
    private readonly updateUseCase: UpdateAiPromptUseCase = new UpdateAiPromptUseCase(),
    private readonly undoUseCase: UndoAiPromptUseCase = new UndoAiPromptUseCase(),
  ) {}

  /** `GET /api/admin/ai-prompts` — os três registros, com conteúdo (sem paginação: cerimônia inútil). */
  async list(req: Request, res: Response): Promise<void> {
    try {
      if (!canReadAiPrompt(cellsOfRequest(req))) {
        res.status(403).json({ success: false, error: 'Forbidden', details: { cell: AI_PROMPT_READ_CELL } });
        return;
      }
      const prompts = await this.getUseCase.list();
      res.status(200).json({ success: true, data: prompts.map(toApiPrompt) });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AiPromptController:list' });
      res.status(500).json({ success: false, error: 'Failed to list ai prompts' });
    }
  }

  /** `GET /api/admin/ai-prompts/{slug}` — um registro. 404 se o slug não é do conjunto ou não tem linha. */
  async get(req: Request, res: Response): Promise<void> {
    try {
      if (!canReadAiPrompt(cellsOfRequest(req))) {
        res.status(403).json({ success: false, error: 'Forbidden', details: { cell: AI_PROMPT_READ_CELL } });
        return;
      }
      const result = await this.getUseCase.execute(req.params.slug);
      if (!result.found) {
        res.status(404).json({ success: false, error: 'ai_prompt_nao_encontrado' });
        return;
      }
      res.status(200).json({ success: true, data: toApiPrompt(result.prompt) });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AiPromptController:get' });
      res.status(500).json({ success: false, error: 'Failed to get ai prompt' });
    }
  }

  /**
   * `PUT /api/admin/ai-prompts/{slug}` — grava conteúdo novo com lock otimista (`version`).
   * Efeito colateral obrigatório (evento `UPDATED` na trilha) é do `UpdateAiPromptUseCase`, não daqui.
   */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const parsed = updateAiPromptBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }

      if (!canUpdateAiPrompt(cellsOfRequest(req))) {
        res.status(403).json({ success: false, error: 'Forbidden', details: { cell: AI_PROMPT_UPDATE_CELL } });
        return;
      }

      const slugParam = req.params.slug;
      if (!isAiPromptSlug(slugParam)) {
        res.status(404).json({ success: false, error: 'ai_prompt_nao_encontrado' });
        return;
      }

      const actor = actorFromRequest(req);
      const result = await this.updateUseCase.execute(
        { slug: slugParam, body: parsed.data.body, expectedVersion: parsed.data.version },
        actor,
      );

      switch (result.outcome) {
        case 'updated':
          res.status(200).json({ success: true, data: toApiPrompt(result.prompt) });
          return;
        case 'invalid':
          // Defesa redundante: `updateAiPromptBodySchema` (`.trim().min(1)`) já barra isto antes.
          res.status(400).json({ success: false, error: 'body_vazio' });
          return;
        case 'not_found':
          res.status(404).json({ success: false, error: 'ai_prompt_nao_encontrado' });
          return;
        case 'conflict':
          res.status(409).json({
            success: false,
            error: 'version_conflict',
            currentVersion: result.currentVersion,
            updatedBy: result.updatedBy,
          });
          return;
      }
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AiPromptController:update' });
      res.status(500).json({ success: false, error: 'Failed to update ai prompt' });
    }
  }

  /**
   * `POST /api/admin/ai-prompts/{slug}/undo` — desfaz a última alteração, um passo, sem alvo
   * (T019b). Exige a MESMA célula de `update` (`ai_prompt:update`) — nunca `ai_prompt:restore`.
   */
  async undo(req: Request, res: Response): Promise<void> {
    try {
      const parsed = undoAiPromptBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }

      if (!canUpdateAiPrompt(cellsOfRequest(req))) {
        res.status(403).json({ success: false, error: 'Forbidden', details: { cell: AI_PROMPT_UPDATE_CELL } });
        return;
      }

      const slugParam = req.params.slug;
      if (!isAiPromptSlug(slugParam)) {
        res.status(404).json({ success: false, error: 'ai_prompt_nao_encontrado' });
        return;
      }

      const actor = actorFromRequest(req);
      const result = await this.undoUseCase.execute(
        { slug: slugParam, expectedVersion: parsed.data.version },
        actor,
      );

      switch (result.outcome) {
        case 'restored':
          res.status(200).json({ success: true, data: toApiPrompt(result.prompt) });
          return;
        case 'not_found':
          res.status(404).json({ success: false, error: 'ai_prompt_nao_encontrado' });
          return;
        case 'conflict':
          res.status(409).json({
            success: false,
            error: 'version_conflict',
            currentVersion: result.currentVersion,
            updatedBy: result.updatedBy,
          });
          return;
        case 'no_previous_version':
          res.status(422).json({ success: false, error: 'sem_versao_anterior' });
          return;
      }
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'AiPromptController:undo' });
      res.status(500).json({ success: false, error: 'Failed to undo ai prompt' });
    }
  }
}
