/**
 * PatientStatusHistoryQueryHelper — a aba Historial da ficha (spec 012, US-B7).
 *
 * Lê `patient_status_history` (migration 254: trigger em `UPDATE OF status`; 255: linha inicial
 * no INSERT). Devolve QUANDO / DE → PARA / ORIGEM (`change_source`, o `app.change_source` da
 * transação que mudou o status: 'admin_panel', 'kanban', 'insert', 'backfill', 'migration-314'…).
 *
 * `actor_uid` (decisão do Gabriel 29/09/2026 — D444, migration 486): substitui o "sem quem" de
 * C7.2; grava e EXIBE o firebase uid (só o ID, nunca nome) na aba Historial (coluna Autor). O
 * aviso M1-1 aos colaboradores segue pendente (dono Gabriel/Marcel); cláusula (c) da política de
 * staff access vale — proibido usar a trilha para avaliação de desempenho/disciplina/dimensionamento.
 * `reason` (mesma migration): motivo fechado de SAÍDA de SUSPENDED (SuspensionExitReason) — NULL nas demais
 * mudanças. Ambos podem vir NULL (histórico anterior à 486, ou mudança de SISTEMA sem ator).
 * ⚠️ `on_hold_note` NUNCA está aqui (lex C7.3): a trilha é append-only e viraria arquivo clínico.
 */
import type { Pool } from 'pg';

export interface PatientStatusHistoryEntry {
  from: string | null;
  to: string;
  source: string | null;
  at: Date;
  reason: string | null;
  actorUid: string | null;
}

export async function fetchPatientStatusHistory(pool: Pool, patientId: string): Promise<PatientStatusHistoryEntry[]> {
  const r = await pool.query<{
    old_value: string | null;
    new_value: string;
    change_source: string | null;
    created_at: Date;
    reason: string | null;
    actor_uid: string | null;
  }>(
    `SELECT old_value, new_value, change_source, created_at, reason, actor_uid
       FROM patient_status_history
      WHERE patient_id = $1
      ORDER BY created_at DESC, id DESC`,
    [patientId],
  );
  return r.rows.map((x) => ({
    from: x.old_value,
    to: x.new_value,
    source: x.change_source,
    at: x.created_at,
    reason: x.reason,
    actorUid: x.actor_uid,
  }));
}
