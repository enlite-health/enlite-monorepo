import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { IMPORT_MIN_DELAY_MS } from '../domain/admissionImport';
import type { SkippedTestStage } from '../domain/admissionRealm';
import { SUMMARY_RETRY_AUTHORIZED_EVENT, type SummaryRetryListFacts } from '../domain/admissionSummaryRetry';
import { lastRetryAuthorizationSql } from './admissionSummaryRetrySql';
import { rehearsalUntilSql, standingSkippedTestSql } from './admissionRehearsalSql';
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
  /** Fim da liberação mais recente do ensaio pago (spec 050 F3); `null` = nunca liberada. */
  rehearsal_until: Date | null;
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
   * Reunião de paciente `is_test` com o `skipped_test` desta etapa já gravado (spec 050, R-18) sai da fila — até uma liberação
   * mais nova (ensaio pago, F3) devolvê-la; a expiração a tira de novo com outro `skipped_test`.
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
                           WHERE e.appointment_id = a.id AND e.kind = 'import_blocked' AND e.reason = $4
                             AND e.at > ${lastRetryAuthorizationSql('a.id')})
          AND NOT ${standingSkippedTestSql('a', 'import')}
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
              a.conference_ended_at, a.import_status, a.import_attempts, p.is_test IS TRUE AS patient_is_test,
              ${rehearsalUntilSql('a')} AS rehearsal_until
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

  /** Há `skipped_test` VIGENTE desta etapa (sem liberação do ensaio mais nova depois dele)? (a mensageria também grava `skipped_test`, com outro motivo.) */
  async hasSkippedTest(appointmentId: string, stage: SkippedTestStage, ex: Ex = this.db): Promise<boolean> {
    const { rows } = await ex.query(
      `SELECT 1 FROM admission_appointments a WHERE a.id = $1 AND ${standingSkippedTestSql('a', stage)}`,
      [appointmentId],
    );
    return rows.length > 0;
  }

  /** O evento de exaustão já foi gravado NESTA rodada (desde a última autorização, F11)? (garante UM só por rodada, seja qual for o estado anterior.) */
  async hasBlockedReason(appointmentId: string, reason: string, ex: Ex = this.db): Promise<boolean> {
    const { rows } = await ex.query(`SELECT 1 FROM admission_events WHERE appointment_id = $1 AND kind = 'import_blocked' AND reason = $2 AND at > ${lastRetryAuthorizationSql('$1::uuid')} LIMIT 1`, [appointmentId, reason]);
    return rows.length > 0;
  }

  /**
   * Tentativas de resumo que chegaram ao Vertex, pelos eventos (sem coluna nova), DESDE a última autorização de reprocesso (spec 050
   * F11, R-38; sem autorização = desde sempre). É a ÚNICA contagem do teto de 3: o serviço de importação e o botão leem esta.
   * Chamado com o lock da reunião seguro.
   */
  async countModelSummaryFailures(appointmentId: string, ex: Ex = this.db): Promise<number> {
    const { rows } = await ex.query<{ n: string }>(
      `SELECT count(*) AS n FROM admission_events
        WHERE appointment_id = $1 AND kind = 'summary_failed' AND reason = ANY($2::text[])
          AND at > ${lastRetryAuthorizationSql('$1::uuid')}`,
      [appointmentId, MODEL_SIDE_SUMMARY_FAILURES],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Os fatos do botão "Reintentar resumen" de TODAS as reuniões `booked` do paciente, numa consulta (a lista da aba; spec 050 F11). */
  async summaryRetryFacts(patientId: string, ex: Ex = this.db): Promise<Array<{ id: string } & SummaryRetryListFacts>> {
    const since = lastRetryAuthorizationSql('a.id');
    const { rows } = await ex.query<{ id: string; status: string; import_status: string | null; model: number; any: number; auths: number }>(
      `SELECT a.id, a.status, a.import_status,
              (SELECT count(*)::int FROM admission_events e WHERE e.appointment_id = a.id AND e.kind = 'summary_failed'
                  AND e.reason = ANY($2::text[]) AND e.at > ${since}) AS model,
              (SELECT count(*)::int FROM admission_events e WHERE e.appointment_id = a.id AND e.kind = 'summary_failed'
                  AND e.at > ${since}) AS any,
              (SELECT count(*)::int FROM admission_events e WHERE e.appointment_id = a.id AND e.kind = '${SUMMARY_RETRY_AUTHORIZED_EVENT}') AS auths
         FROM admission_appointments a
        WHERE a.patient_id = $1 AND a.status = 'booked'`,
      [patientId, MODEL_SIDE_SUMMARY_FAILURES],
    );
    return rows.map((r) => ({
      id: r.id, appointmentStatus: r.status, importStatus: r.import_status,
      modelFailuresSinceAuthorization: r.model, anyFailuresSinceAuthorization: r.any, authorizations: r.auths,
    }));
  }

  /** Autorizações de reprocesso já dadas à reunião (R-38; o teto é `MAX_SUMMARY_RETRY_AUTHORIZATIONS`). */
  async countRetryAuthorizations(appointmentId: string, ex: Ex = this.db): Promise<number> {
    const { rows } = await ex.query<{ n: string }>(
      `SELECT count(*) AS n FROM admission_events WHERE appointment_id = $1 AND kind = '${SUMMARY_RETRY_AUTHORIZED_EVENT}'`,
      [appointmentId],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
