import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { IMPORT_MIN_DELAY_MS } from '../domain/admissionImport';
import { SKIPPED_TEST_EVENT, type SkippedTestStage } from '../domain/admissionRealm';
import { MODEL_SIDE_SUMMARY_FAILURES, SUMMARY_ATTEMPTS_EXHAUSTED } from '../application/ports/AdmissionImportPorts';

type Ex = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface ImportCandidate {
  id: string;
  patient_id: string;
  country: string;
  host_email: string;
  admission_code: string | null;
  slot_start: Date;
  status: string;
  conference_ended_at: Date | null;
  import_status: string | null;
  import_attempts: number;
  /** `patients.is_test` — a entrada da função `admissionRealm` (R-18). */
  patient_is_test: boolean;
}

export type ImportState = 'waiting' | 'done' | 'rejected' | 'ambiguous' | 'expired' | 'blocked';

/**
 * AdmissionImportRepository — SQL da importação do Tactiq (spec 049 F6). O relógio entra por parâmetro. Quem importa é DONA dos
 * estados `waiting | done | rejected | ambiguous | expired` (a F5 só escreve `pending`, `blocked` por Meet e `no_show`).
 */
export class AdmissionImportRepository {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  /**
   * Devidas: reunião `booked` NOVA, com fim real gravado há mais de 10 min, ainda não terminal. `blocked` volta à fila (o
   * vínculo pode ter sido refeito); o `conference_ended_at IS NOT NULL` o separa do `blocked` da F5 (escopo do Meet).
   * Reunião de paciente `is_test` com o `skipped_test` desta etapa já gravado (spec 050, R-18) sai da fila.
   */
  async listDueIds(now: Date, limit = 50, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT a.id FROM admission_appointments a
        WHERE a.status = 'booked'
          AND a.admission_code IS NOT NULL
          AND a.conference_ended_at IS NOT NULL
          AND a.conference_ended_at <= $1::timestamptz - make_interval(secs => $3::double precision)
          AND a.import_status IN ('pending', 'waiting', 'blocked')
          AND NOT EXISTS (SELECT 1 FROM admission_events e
                           WHERE e.appointment_id = a.id AND e.kind = 'import_blocked' AND e.reason = $4)
          AND NOT EXISTS (SELECT 1 FROM admission_events e
                           WHERE e.appointment_id = a.id AND e.kind = '${SKIPPED_TEST_EVENT}' AND e.reason = 'import')
        ORDER BY a.conference_ended_at
        LIMIT $2`,
      [now, limit, IMPORT_MIN_DELAY_MS / 1000, SUMMARY_ATTEMPTS_EXHAUSTED],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Leitura da reunião. A exclusão mútua NÃO é daqui: é o advisory lock de SESSÃO que o serviço segura durante todo o trabalho
   * (nenhuma transação fica aberta enquanto se fala com Tactiq, cofre ou Vertex).
   */
  async find(id: string, ex: Ex = this.db): Promise<ImportCandidate | null> {
    const { rows } = await ex.query<ImportCandidate>(
      `SELECT a.id, a.patient_id, a.country, a.host_email, a.admission_code, a.slot_start, a.status,
              a.conference_ended_at, a.import_status, a.import_attempts, p.is_test IS TRUE AS patient_is_test
         FROM admission_appointments a
         JOIN patients p ON p.id = a.patient_id
        WHERE a.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async setState(id: string, state: ImportState, ex: Ex, opts: { countAttempt?: boolean } = {}): Promise<void> {
    await ex.query(
      `UPDATE admission_appointments
          SET import_status = $2, import_attempts = import_attempts + $3, updated_at = NOW()
        WHERE id = $1`,
      [id, state, opts.countAttempt ? 1 : 0],
    );
  }

  async hasEvent(appointmentId: string, kind: string, ex: Ex = this.db): Promise<boolean> {
    const { rows } = await ex.query(`SELECT 1 FROM admission_events WHERE appointment_id = $1 AND kind = $2 LIMIT 1`, [appointmentId, kind]);
    return rows.length > 0;
  }

  /** O `skipped_test` DESTA etapa já está na trilha? (a mensageria também grava `skipped_test`, com outro motivo.) */
  async hasSkippedTest(appointmentId: string, stage: SkippedTestStage, ex: Ex = this.db): Promise<boolean> {
    const { rows } = await ex.query(
      `SELECT 1 FROM admission_events WHERE appointment_id = $1 AND kind = '${SKIPPED_TEST_EVENT}' AND reason = $2 LIMIT 1`,
      [appointmentId, stage],
    );
    return rows.length > 0;
  }

  /** O evento de exaustão já foi gravado? (garante UM só, seja qual for o estado anterior da reunião.) */
  async hasBlockedReason(appointmentId: string, reason: string, ex: Ex = this.db): Promise<boolean> {
    const { rows } = await ex.query(`SELECT 1 FROM admission_events WHERE appointment_id = $1 AND kind = 'import_blocked' AND reason = $2 LIMIT 1`, [appointmentId, reason]);
    return rows.length > 0;
  }

  /** Tentativas de resumo que chegaram ao Vertex, pelos eventos (sem coluna nova). Chamado com o lock da reunião seguro. */
  async countModelSummaryFailures(appointmentId: string, ex: Ex = this.db): Promise<number> {
    const { rows } = await ex.query<{ n: string }>(
      `SELECT count(*) AS n FROM admission_events WHERE appointment_id = $1 AND kind = 'summary_failed' AND reason = ANY($2::text[])`,
      [appointmentId, MODEL_SIDE_SUMMARY_FAILURES],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
