/**
 * WorkerMergeAuditWriter
 *
 * Insere a linha de auditoria de um merge em worker_merge_audit com o rastro
 * COMPLETO (quem/de onde/como). Extraído de WorkerPhoneMergeService para manter
 * o serviço ≤400 linhas e concentrar o contrato da auditoria num só lugar.
 *
 * Defaults: actor "system" / source "auto_batch" quando não há contexto admin
 * (merge automático em lote) — assim todo merge fica distinguível na auditoria.
 * Os emails das duas contas são buscados aqui (cobre admin e batch uniformemente).
 */

import type { PoolClient } from 'pg';
import type {
  AppliedOverride,
  MergeAuditContext,
  UndoAuditContext,
} from '../../application/dedup/DedupTypes';
import type { LegalFieldException } from './WorkerPhoneMergeTypes';

/** Contexto + escolhas de campo do merge, propagado até o INSERT da auditoria. */
export type MergeAuditInput = MergeAuditContext & {
  fieldChoices?: Record<string, string>;
  appliedOverrides?: AppliedOverride[];
};

export interface MergeAuditInsertParams {
  survivorId: string;
  absorbedId: string;
  phoneNormalized: string;
  category: string;
  legalFieldExceptions: LegalFieldException[];
  audit: MergeAuditInput;
}

/**
 * Insere a auditoria e devolve o id (BIGINT) gerado.
 * fields_filled nasce vazio — é atualizado após o COALESCE pelo chamador.
 */
export async function insertMergeAuditRow(
  client: PoolClient,
  p: MergeAuditInsertParams,
): Promise<bigint> {
  const a = p.audit ?? {};

  const emails = await client.query<{ id: string; email: string | null }>(
    'SELECT id, email FROM workers WHERE id = ANY($1::uuid[])',
    [[p.survivorId, p.absorbedId]],
  );
  const emailById = new Map(emails.rows.map(r => [r.id, r.email ?? null]));

  const res = await client.query<{ id: string }>(
    `INSERT INTO worker_merge_audit
       (survivor_id, absorbed_id, phone_normalized, category, fields_filled, exceptions,
        executed_by, executed_by_email, source, confirmed_same_person,
        ip_address, user_agent, request_id, field_choices, applied_overrides,
        survivor_email, absorbed_email)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb,
             $7, $8, $9, $10,
             $11, $12, $13, $14::jsonb, $15::jsonb,
             $16, $17)
     RETURNING id`,
    [
      p.survivorId,
      p.absorbedId,
      p.phoneNormalized,
      p.category,
      JSON.stringify([]), // fields_filled preenchido após COALESCE
      JSON.stringify(p.legalFieldExceptions),
      a.executedBy ?? 'system',
      a.executedByEmail ?? null,
      a.source ?? 'auto_batch',
      a.confirmedSamePerson ?? null,
      a.ipAddress ?? null,
      a.userAgent ?? null,
      a.requestId ?? null,
      JSON.stringify(a.fieldChoices ?? {}),
      JSON.stringify(a.appliedOverrides ?? []),
      emailById.get(p.survivorId) ?? null,
      emailById.get(p.absorbedId) ?? null,
    ],
  );
  return BigInt(res.rows[0].id);
}

/** Carimba na auditoria QUEM desfez o merge (e de onde). Chamado dentro da txn do undo. */
export async function recordUndoAudit(
  client: PoolClient,
  auditId: number | bigint,
  ctx: UndoAuditContext,
): Promise<void> {
  await client.query(
    `UPDATE worker_merge_audit
        SET undone_by = $2, undone_by_email = $3, undone_at = NOW(),
            undo_ip_address = $4, undo_user_agent = $5, undo_request_id = $6
      WHERE id = $1`,
    [
      auditId,
      ctx.undoneBy ?? 'system',
      ctx.undoneByEmail ?? null,
      ctx.ipAddress ?? null,
      ctx.userAgent ?? null,
      ctx.requestId ?? null,
    ],
  );
}
