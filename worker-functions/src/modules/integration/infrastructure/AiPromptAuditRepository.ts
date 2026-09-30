/**
 * AiPromptAuditRepository
 *
 * Casca fina sobre `BaseAuditLogRepository` (src/shared/audit/BaseAuditLogRepository.ts)
 * configurada para a tabela `ai_prompt_audit_log` com FK `prompt_id` (migration 485).
 * Mesmo padrão de composição de `JobPostingAuditRepository`
 * (src/modules/matching/infrastructure/JobPostingAuditRepository.ts) — composição, não herança,
 * porque a assinatura pública (promptId vs entityId) violaria contravariância de parâmetros em
 * TypeScript strict caso fosse herança.
 *
 * ⚠️ Expõe SÓ `logEvent` — de propósito, NÃO `logEventSafe`.
 * `logEventSafe` (BaseAuditLogRepository.ts:110-130) engole qualquer erro do INSERT de auditoria
 * num SAVEPOINT, para que a transação envolvente ainda comite mesmo se a trilha falhar. Isso é
 * correto nos outros módulos (JobPosting, Worker…), onde a trilha é acessória.
 * AQUI NÃO: a trilha É a funcionalidade (FR-013, FR-014, data-model.md "Regras de escrita" #2) —
 * é o que permite comparar versões e restaurar. Se o evento de auditoria não gravar, a escrita do
 * conteúdo em `ai_prompts` TEM que abortar junto (mesma transação, mesmo client) — senão sobra
 * conteúdo novo sem registro de quem o pôs, que é exatamente o buraco que a spec 029 veio fechar.
 * `logEvent` propaga a exceção do INSERT sem SAVEPOINT: o caller (UpdateAiPromptUseCase/
 * RestoreAiPromptUseCase, T010/T038) fica com a transação abortada e precisa fazer ROLLBACK —
 * não há como "recuperar" silenciosamente. NÃO adicionar aqui um wrapper para `logEventSafe`
 * depois — isso reabriria o buraco.
 *
 * ⚠️ `AiPromptEventType` inclui `'RESTORED'`, que o `AuditEventType` compartilhado
 * (src/shared/audit/types.ts) NÃO tem (ele só tem CREATED/UPDATED/DELETED/STATUS_CHANGED/
 * DRAFT_CHANGED — nenhum módulo antes deste precisou de RESTORED). O `CHECK (event_type IN
 * ('CREATED','UPDATED','RESTORED'))` da migration 485 é o domínio real, verificado pelo Postgres
 * em runtime; o cast abaixo só alinha o tipo estático a esse domínio sem editar o arquivo
 * compartilhado (fora do escopo desta task — ver LISTA do relatório de entrega).
 */

import type { PoolClient } from 'pg';
import { BaseAuditLogRepository } from '@shared/audit/BaseAuditLogRepository';
import type { AuditEventType, AuditActorType, AuditChangesPayload } from '@shared/audit/types';

// ─── Re-exports de tipos compartilhados ──────────────────────────────────────
// Callers importam esses símbolos diretamente deste arquivo — manter os paths.

export type { AuditActorType, AuditChangesPayload } from '@shared/audit/types';

// ─── Tipo de evento específico de ai_prompt_audit_log ────────────────────────

/** Domínio real do `CHECK (event_type IN (...))` de `ai_prompt_audit_log` (migration 485). */
export type AiPromptEventType = 'CREATED' | 'UPDATED' | 'RESTORED';

// ─── Tipos da API pública específicos de prompts de IA ───────────────────────

/** Parâmetros de logEvent com `promptId` (API pública desta casca). */
export interface LogAiPromptEventParams {
  promptId: string;
  eventType: AiPromptEventType;
  /** `{ before, after }` com o conteúdo INTEGRAL de `body` — não a diferença (data-model.md D3). */
  changes: AuditChangesPayload;
  /** firebase_uid de quem executou a ação. Obrigatório quando actorType === 'HUMAN' (CHECK da 486). */
  actorUserId?: string | null;
  actorType: AuditActorType;
  /** Obrigatório quando actorType !== 'HUMAN' (CHECK da 486). Ex.: 'migration-485-seed'. */
  actorLabel?: string | null;
  traceId?: string | null;
}

// ─── Repositório (composição) ─────────────────────────────────────────────────

/** Instância interna compartilhada por todos os métodos desta casca. */
const BASE = new BaseAuditLogRepository({
  tableName: 'ai_prompt_audit_log',
  entityColumn: 'prompt_id',
});

export class AiPromptAuditRepository {
  /**
   * Registra um único evento de auditoria dentro de uma transação existente.
   * Adapta `promptId` → `entityId` ao chamar a base. `field_name` é sempre `'body'` nesta
   * entrega (data-model.md — não há outro campo editável em `ai_prompts`).
   *
   * NÃO usa SAVEPOINT (ao contrário de `logEventSafe`): se o INSERT falhar, a exceção sobe para
   * o `client` do caller, que deve fazer ROLLBACK — a escrita do conteúdo não pode sobreviver
   * sozinha.
   *
   * @param client - PoolClient da transação aberta pelo caller (a MESMA que grava `ai_prompts`)
   * @param params - Dados do evento
   */
  async logEvent(client: PoolClient, params: LogAiPromptEventParams): Promise<void> {
    return BASE.logEvent(client, {
      entityId: params.promptId,
      eventType: params.eventType as AuditEventType,
      fieldName: 'body',
      changes: params.changes,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      actorLabel: params.actorLabel,
      traceId: params.traceId,
    });
  }
}
