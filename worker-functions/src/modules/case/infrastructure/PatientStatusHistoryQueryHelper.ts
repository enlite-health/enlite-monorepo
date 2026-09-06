/**
 * PatientStatusHistoryQueryHelper — a aba Historial da ficha (spec 012, US-B7).
 *
 * Lê `patient_status_history` (migration 254: trigger em `UPDATE OF status`; 255: linha inicial
 * no INSERT). Devolve QUANDO / DE → PARA / ORIGEM (`change_source`, o `app.change_source` da
 * transação que mudou o status: 'admin_panel', 'kanban', 'insert', 'backfill', 'migration-314'…).
 *
 * ⚠️ SEM `actor_uid` nesta rodada (lex C7.2): a tabela não tem coluna de ator, e criá-la é dado de
 * monitoramento de colaborador — depende do aviso M1-1. Vai para LISTA.
 * ⚠️ `on_hold_note` NUNCA está aqui (lex C7.3): a trilha é append-only e viraria arquivo clínico.
 */
import type { Pool } from 'pg';

export interface PatientStatusHistoryEntry {
  from: string | null;
  to: string;
  source: string | null;
  at: Date;
}

export async function fetchPatientStatusHistory(pool: Pool, patientId: string): Promise<PatientStatusHistoryEntry[]> {
  const r = await pool.query<{ old_value: string | null; new_value: string; change_source: string | null; created_at: Date }>(
    `SELECT old_value, new_value, change_source, created_at
       FROM patient_status_history
      WHERE patient_id = $1
      ORDER BY created_at DESC, id DESC`,
    [patientId],
  );
  return r.rows.map((x) => ({ from: x.old_value, to: x.new_value, source: x.change_source, at: x.created_at }));
}
