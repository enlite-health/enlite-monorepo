/**
 * UndoAiPromptUseCase — desfaz a ÚLTIMA alteração de `ai_prompts`, voltando um passo
 * (spec 029 T019b, `contracts/admin-ai-prompts.md` §"POST .../undo").
 *
 * ⚠️ **Não recebe alvo.** Só a `version` atual (lock otimista) — nunca um id de evento nem uma
 * versão de destino. É o desenho que torna a ação segura para quem edita: não existe forma de
 * apontar para a versão errada. Saltar para um ponto ARBITRÁRIO do passado é `restore`
 * (`ai_prompt:restore`, Fase 5) — permissão separada, fora do escopo desta task.
 *
 * Mecanismo (espelha `UpdateAiPromptUseCase`, T010):
 * 1. `AiPromptRepository.findBySlug` fora da transação — dá o conteúdo/version atuais para a
 *    mensagem de conflito e para `changes.before` do evento `RESTORED`.
 * 2. O conteúdo a restaurar NÃO vem de `AiPrompt` (que não guarda histórico) — vem do
 *    `changes.before` do evento mais recente de `ai_prompt_audit_log` para este prompt. Nem
 *    `AiPromptRepository` nem `AiPromptAuditRepository` expõem "pegue o último evento" (fora do
 *    escopo desta task editar esses dois arquivos — ver LISTA do relatório de entrega), então a
 *    consulta mora aqui, com SQL explícito, no MESMO formato de coluna que
 *    `idx_ai_prompt_audit_log_prompt (prompt_id, created_at DESC)` já otimiza.
 * 3. Sem nenhum evento, ou com `changes.before === null` (a marca do evento `CREATED` — migration
 *    487/488 gravam `before: NULL` na semeadura, `data-model.md` linha do `CREATED`): não há
 *    versão anterior para voltar. `outcome: 'no_previous_version'` (422) — **não escreve nada**.
 * 4. Escrita e trilha na MESMA transação via `withActorContext`, reaproveitando
 *    `AiPromptRepository.updateBody` (o mesmo lock otimista do `Update`) e
 *    `AiPromptAuditRepository.logEvent` (nunca `logEventSafe` — mesma razão do `UpdateAiPromptUseCase`:
 *    a trilha É a funcionalidade). Evento `RESTORED`, com `changes.undoneEventId` apontando o `id`
 *    do evento desfeito — campo extra ao lado de `before`/`after` (permitido em runtime: a coluna é
 *    JSONB e não há schema fixo além do que os dois campos documentados exigem; `AuditChangesPayload`
 *    aceita porque a atribuição passa por uma variável tipada mais larga, não por um literal inline
 *    — o mesmo truque que o comentário de `AiPromptAuditRepository.ts` descreve para o cast de
 *    `AiPromptEventType`).
 */

import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import type { ActorContext } from '@shared/audit/actorSource';
import type { AiPromptSlug } from '../domain/AiPromptSlug';
import { AiPromptRepository, type AiPrompt } from '../infrastructure/AiPromptRepository';
import { AiPromptAuditRepository, type AuditActorType } from '../infrastructure/AiPromptAuditRepository';

// ─── Input / Output ────────────────────────────────────────────────────────────

export interface UndoAiPromptInput {
  slug: AiPromptSlug;
  /** Versão que o cliente leu — lock otimista, igual ao `Update`. NÃO é um alvo de restauração. */
  expectedVersion: number;
}

export interface UndoAiPromptActor {
  actorUserId: string | null;
  actorType: AuditActorType;
  actorLabel: string | null;
  traceId?: string | null;
}

export type UndoAiPromptResult =
  | { outcome: 'restored'; prompt: AiPrompt }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; currentVersion: number; updatedBy: string | null }
  /** Não existe evento anterior a desfazer (o mais recente é o `CREATED` — `changes.before` nulo). */
  | { outcome: 'no_previous_version' };

/** Linha da consulta ao evento mais recente da trilha para este slug (join por `prompt_id`). */
interface LastAuditEventRow {
  event_id: string;
  prompt_id: string;
  changes: { before: unknown; after: unknown } | null;
}

// ─── Use case ───────────────────────────────────────────────────────────────────

export class UndoAiPromptUseCase {
  private readonly pool: Pool;

  constructor(
    private readonly repo: AiPromptRepository = new AiPromptRepository(),
    private readonly auditRepo: AiPromptAuditRepository = new AiPromptAuditRepository(),
    pool?: Pool,
  ) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async execute(input: UndoAiPromptInput, actor: UndoAiPromptActor): Promise<UndoAiPromptResult> {
    const current = await this.repo.findBySlug(input.slug);
    if (!current) {
      return { outcome: 'not_found' };
    }

    // Fora da transação, como o `before` do Update: leitura pura. Se alguém escrever no meio, o
    // `WHERE version = $` de `updateBody` (dentro da transação, abaixo) pega a divergência e devolve
    // conflito sem gravar nada — este SELECT não decide sozinho o que persiste.
    const lastEventResult = await this.pool.query<LastAuditEventRow>(
      `SELECT a.id AS event_id, a.prompt_id AS prompt_id, a.changes AS changes
         FROM ai_prompt_audit_log a
         JOIN ai_prompts p ON p.id = a.prompt_id
        WHERE p.slug = $1
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [input.slug],
    );
    const lastEvent = lastEventResult.rows[0];
    if (!lastEvent) {
      // Nunca deveria acontecer em produção (T016/T047-T049 sempre semeiam um `CREATED` junto da
      // linha de `ai_prompts`), mas por segurança: sem NENHUM evento, não há "anterior" a inventar.
      return { outcome: 'no_previous_version' };
    }

    const previousBody = lastEvent.changes?.before;
    if (typeof previousBody !== 'string') {
      // `changes.before === null` é a marca do evento `CREATED` (migrations 487/488): não há
      // conteúdo anterior a esse ponto. Qualquer outro tipo (ou `changes` ausente) é dado
      // corrompido — mesmo tratamento, nunca inventar um "anterior" que a trilha não registrou.
      return { outcome: 'no_previous_version' };
    }

    const updatedByValue =
      actor.actorType === 'HUMAN' ? (actor.actorUserId ?? 'unknown') : (actor.actorLabel ?? 'unknown');

    return withActorContext<UndoAiPromptResult>(
      this.pool,
      async (client: PoolClient) => {
        const result = await this.repo.updateBody(
          input.slug,
          previousBody,
          input.expectedVersion,
          updatedByValue,
          client,
        );

        if (result.outcome !== 'updated') {
          // Conflito ou not_found (janela de corrida entre o SELECT acima e este UPDATE): nada foi
          // gravado, e por isso nada vai para a trilha.
          return result;
        }

        // `changes` como variável tipada mais larga que `AuditChangesPayload` — não um literal
        // inline — para poder carregar `undoneEventId` sem violar o `excess property check` do
        // TypeScript (mesmo raciocínio do cast documentado em `AiPromptAuditRepository.ts`).
        const changes: { before: unknown; after: unknown; undoneEventId: string } = {
          before: current.body,
          after: result.prompt.body,
          undoneEventId: lastEvent.event_id,
        };

        await this.auditRepo.logEvent(client, {
          promptId: lastEvent.prompt_id,
          eventType: 'RESTORED',
          changes,
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actorLabel: actor.actorLabel,
          traceId: actor.traceId ?? null,
        });

        return { outcome: 'restored', prompt: result.prompt };
      },
      toDbActorContext(actor),
    );
  }
}

// ─── Ator para o GUC da transação (roteamento de pool, não trigger) ────────────
// Idêntico a `UpdateAiPromptUseCase.toDbActorContext` — duplicado de propósito: são 6 linhas, e
// extrair um helper compartilhado para isso está fora do escopo nomeado desta task.

function toDbActorContext(actor: UndoAiPromptActor): ActorContext | undefined {
  if (actor.actorType === 'HUMAN') {
    return actor.actorUserId ? { source: 'admin_panel', id: `staff:${actor.actorUserId}` } : undefined;
  }
  return actor.actorLabel
    ? { source: 'system_auto', id: `${actor.actorType.toLowerCase()}:${actor.actorLabel}` }
    : undefined;
}
