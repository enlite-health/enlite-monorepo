/**
 * UpdateAiPromptUseCase — grava conteúdo novo em `ai_prompts` com lock otimista e trilha na
 * MESMA transação (spec 029 T010, `data-model.md` §"Regras de escrita").
 *
 * Regras aplicadas aqui (não no repositório, que é infraestrutura pura):
 * 1. Corpo vazio ou só espaços é recusado ANTES de abrir transação — `{outcome:'invalid'}`.
 *    O `CHECK (length(btrim(body)) > 0)` da migration 485 e o Zod de `aiPromptSchemas.ts` (T011)
 *    são as outras duas camadas da mesma regra 3 de "Regras de escrita"; esta é a terceira.
 * 2. Lock otimista: `expectedVersion` divergente não grava — `AiPromptRepository.updateBody`
 *    resolve isso e devolve `{outcome:'conflict'}` ou `{outcome:'not_found'}`, sem gravar nada.
 * 3. Escrita bem-sucedida grava o evento `UPDATED` na trilha (`AiPromptAuditRepository.logEvent`,
 *    NUNCA `logEventSafe`) DENTRO da mesma transação: se o INSERT da trilha falhar, a exceção sobe
 *    e `withActorContext` faz ROLLBACK — a escrita do conteúdo não sobrevive sozinha. É a regra 2
 *    de "Regras de escrita" e o que os comentários de `AiPromptAuditRepository.ts` chamam de "o
 *    buraco que esta entrega veio fechar": conteúdo novo sem registro de quem o pôs.
 * 4. `changes` é montado com `captureEntityDiff` (allowedFields = ['body']) e guarda o conteúdo
 *    ANTERIOR INTEGRAL, não a diferença — `data-model.md` D3. Quando o corpo salvo é idêntico ao
 *    anterior (save sem alteração real, ainda assim bumpa `version`), `captureEntityDiff` não acha
 *    diff nenhum (`before === after`) e cairíamos sem `changes`; por isso há um fallback explícito
 *    que preenche `{before, after}` com o conteúdo integral de antes/depois mesmo nesse caso — a
 *    trilha nunca fica sem o snapshot.
 *
 * Mecanismo de transação: `withActorContext` (`@shared/database/actorContext`), o MESMO usado por
 * `ReactivateArchivedWorkerUseCase.applyReactivation` — não `pool.connect()` cru. Medido neste
 * repo: abrir transação crua, sem o wrapper, sai do roteamento por identidade de
 * `rlsAwarePool.ts` (`app_runtime` vs `app_system`) e derruba a requisição com 500 sob RLS.
 * `ai_prompts`/`ai_prompt_audit_log` não têm trigger que leia `app.current_uid` (ao contrário de
 * `worker_status_history`), mas o roteamento de pool por identidade não é opcional — daí o mesmo
 * mecanismo aqui, com o `ActorContext` derivado do ator específico deste módulo em
 * `toDbActorContext`. Sem ator explícito derivável (actorType HUMAN sem actorUserId, o que a
 * validação de entrada já deveria ter barrado), cai no ator da request via ALS — mesmo
 * comportamento de `BookInterviewSlotUseCase`.
 */

import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import type { ActorContext } from '@shared/audit/actorSource';
import { captureEntityDiff } from '@shared/audit/captureEntityDiff';
import type { AiPromptSlug } from '../domain/AiPromptSlug';
import { AiPromptRepository, type UpdateAiPromptOutcome } from '../infrastructure/AiPromptRepository';
import { AiPromptAuditRepository, type AuditActorType } from '../infrastructure/AiPromptAuditRepository';

// ─── Input / Output ────────────────────────────────────────────────────────────

export interface UpdateAiPromptInput {
  slug: AiPromptSlug;
  body: string;
  /** Versão que o cliente leu — lock otimista (regra 1 de "Regras de escrita"). */
  expectedVersion: number;
}

export interface UpdateAiPromptActor {
  /** uid de quem editou. Obrigatório quando `actorType === 'HUMAN'` (CHECK da migration 485). */
  actorUserId: string | null;
  actorType: AuditActorType;
  /** Obrigatório quando `actorType !== 'HUMAN'` (CHECK da migration 485). */
  actorLabel: string | null;
  traceId?: string | null;
}

export type UpdateAiPromptResult =
  | UpdateAiPromptOutcome
  | { outcome: 'invalid'; reason: 'empty_body' };

// ─── Use case ───────────────────────────────────────────────────────────────────

export class UpdateAiPromptUseCase {
  private readonly pool: Pool;

  constructor(
    private readonly repo: AiPromptRepository = new AiPromptRepository(),
    private readonly auditRepo: AiPromptAuditRepository = new AiPromptAuditRepository(),
    pool?: Pool,
  ) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async execute(input: UpdateAiPromptInput, actor: UpdateAiPromptActor): Promise<UpdateAiPromptResult> {
    const body = input.body.trim();
    if (!body) {
      return { outcome: 'invalid', reason: 'empty_body' };
    }

    // Snapshot "before" fora da transação: se o UPDATE (dentro dela) tiver sucesso, é porque a
    // `version` não mudou desde esta leitura — ninguém escreveu no meio — então este `body` É o
    // conteúdo imediatamente anterior ao que estamos prestes a gravar. Se alguém tiver escrito no
    // meio, `expectedVersion` diverge e o outcome vira `conflict`/`not_found` sem tocar a trilha.
    const before = await this.repo.findBySlug(input.slug);
    if (!before) {
      return { outcome: 'not_found' };
    }

    const updatedByValue =
      actor.actorType === 'HUMAN' ? (actor.actorUserId ?? 'unknown') : (actor.actorLabel ?? 'unknown');

    return withActorContext<UpdateAiPromptOutcome>(
      this.pool,
      async (client: PoolClient) => {
        const result = await this.repo.updateBody(input.slug, body, input.expectedVersion, updatedByValue, client);

        if (result.outcome !== 'updated') {
          // Conflito ou not_found: nada foi gravado. Nada para auditar.
          return result;
        }

        // AiPromptRepository não expõe `id` (SELECT_COLUMNS não o inclui, T007 é arquivo
        // compartilhado que esta task não pode editar) — buscado aqui, na MESMA transação, só no
        // caminho de sucesso, para a FK `prompt_id` da trilha.
        const idRow = await client.query<{ id: string }>('SELECT id FROM ai_prompts WHERE slug = $1', [
          input.slug,
        ]);
        const promptId = idRow.rows[0]?.id;
        if (!promptId) {
          // Invariante: a linha que acabamos de dar UPDATE não pode ter sumido dentro da mesma
          // transação. Lançar aqui aborta a transação (ROLLBACK via withActorContext) em vez de
          // gravar conteúdo novo sem trilha.
          throw new Error(
            `UpdateAiPromptUseCase: id não encontrado para slug ${input.slug} logo após update bem-sucedido`,
          );
        }

        const diffs = captureEntityDiff({ body: before.body }, { body: result.prompt.body }, ['body']);
        const [diff] = diffs;
        // Conteúdo INTEGRAL, nunca a diferença (data-model.md D3). Fallback cobre o caso raro de
        // salvar o mesmo texto (version ainda incrementa; captureEntityDiff não acha diff nenhum).
        const changes = diff
          ? { before: diff.before, after: diff.after }
          : { before: before.body, after: result.prompt.body };

        await this.auditRepo.logEvent(client, {
          promptId,
          eventType: 'UPDATED',
          changes,
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actorLabel: actor.actorLabel,
          traceId: actor.traceId ?? null,
        });

        return result;
      },
      toDbActorContext(actor),
    );
  }
}

// ─── Ator para o GUC da transação (roteamento de pool, não trigger) ────────────

/**
 * Deriva o `ActorContext` genérico (`app.current_uid`/`app.change_source`, consumido pelo
 * roteamento de pool de `rlsAwarePool.ts`) do ator específico de `ai_prompts`. Nenhum trigger
 * desta tabela lê esses GUCs — só existem hoje para `worker_status_history` e afins — mas
 * `withActorContext` é o mecanismo único da casa para abrir transação roteada corretamente.
 * Sem como derivar (HUMAN sem uid, ou não-HUMAN sem label), devolve `undefined` e
 * `withActorContext` cai no ator da request via ALS — mesmo comportamento dos demais call sites
 * de controller (`BookInterviewSlotUseCase`).
 */
function toDbActorContext(actor: UpdateAiPromptActor): ActorContext | undefined {
  if (actor.actorType === 'HUMAN') {
    return actor.actorUserId ? { source: 'admin_panel', id: `staff:${actor.actorUserId}` } : undefined;
  }
  return actor.actorLabel
    ? { source: 'system_auto', id: `${actor.actorType.toLowerCase()}:${actor.actorLabel}` }
    : undefined;
}
