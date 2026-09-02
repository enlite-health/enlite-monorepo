import type { Pool } from 'pg';
import * as functions from 'firebase-functions';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  AdmissionCalendarService,
  admissionCalendarService,
} from '../../matching/infrastructure/AdmissionCalendarService';
import {
  getAdmissionCountryConfig,
  type AdmissionCountry,
} from '../../matching/domain/admissionCountries';

/** Tentativa de purgar um paciente que NÃO está marcado como teste. */
export class NotATestPatientError extends Error {
  readonly code = 'NOT_A_TEST_PATIENT';
  constructor(patientId: string) {
    super(`Patient ${patientId} is not marked as is_test — refusing to purge`);
    this.name = 'NotATestPatientError';
  }
}

/** Evidência do que a limpeza realmente fez (o E2E assere em cima disto). */
export interface PurgeResult {
  patientId: string;
  appointmentsCancelled: number;
  calendarEventsDeleted: number;
  calendarEventsFailed: number;
  vacanciesDeleted: number;
}

interface AppointmentRow {
  id: string;
  country: string | null;
  calendar_event_id: string | null;
}

/**
 * PatientTestFixtureService — marcar e LIMPAR pacientes sintéticos.
 *
 * Existe por causa do synthetic monitoring (e2e-prod): a jornada diária cria um
 * paciente REAL em produção para provar que o pipeline funciona ponta a ponta,
 * inclusive que o big number sobe na tela. Sem uma forma de limpar, isso vira
 * um paciente falso por dia na lista da equipe de admissão e no funil.
 *
 * A TRAVA: `purge` só age sobre `patients.is_test = true`. Um paciente real faz
 * o método lançar `NotATestPatientError` — não existe caminho, nem por engano
 * nem por id errado, em que este serviço apague dado de gente de verdade.
 *
 * A limpeza é FÍSICA (DELETE). A versão anterior marcava `deleted_at` "para
 * continuar auditável", e o efeito medido em produção (02/09/2026) foi 149
 * pacientes sintéticos acumulados desde 30/07 — invisíveis nas telas, mas vivos
 * na tabela e contaminando toda consulta que não filtre `deleted_at`. Dado de
 * teste não sobrevive ao teste que o criou; a auditabilidade mora no log
 * `patient.test_purge.done`, que registra o que a limpeza fez sem reter PII.
 *
 * As 6 tabelas-filhas em ON DELETE CASCADE (patient_addresses, patient_chat_ids,
 * patient_field_overrides_audit, patient_professionals, patient_responsibles,
 * patient_status_history) saem junto. As que são NO ACTION precisam sair ANTES,
 * ou a FK aborta o DELETE: `admission_appointments` e `job_postings` são
 * apagadas aqui. Falta `vacancy_relink_audit.new_patient_id` — hoje sem nenhuma
 * linha de teste, mas capaz de travar o purge no dia em que houver.
 */
export class PatientTestFixtureService {
  constructor(
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly calendar: AdmissionCalendarService = admissionCalendarService,
    private readonly impersonateEmail: string = process.env.ADMISSION_IMPERSONATE_EMAIL ||
      'enlite@enlite.health',
  ) {}

  /**
   * Liga/desliga a marca de teste. Devolve o valor gravado, ou null se o
   * paciente não existe (o controller traduz para 404).
   */
  async setTestFlag(patientId: string, isTest: boolean): Promise<boolean | null> {
    const { rows } = await this.db.query<{ is_test: boolean }>(
      `UPDATE patients
          SET is_test = $2, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING is_test`,
      [patientId, isTest],
    );
    return rows[0]?.is_test ?? null;
  }

  /**
   * Remove o rastro de um paciente de teste: evento(s) no Google Calendar,
   * entrevista(s) de admissão, vaga(s) geradas e o próprio paciente — todos
   * apagados de verdade, sem linha remanescente.
   *
   * Ordem importa: o evento do Calendar sai PRIMEIRO (é o efeito externo — se
   * falhar, queremos saber antes de perder a referência no banco). A falha em
   * apagar um evento não aborta a limpeza; ela é CONTADA no resultado, para o
   * E2E poder falhar em cima de um número em vez de um log.
   */
  async purge(patientId: string): Promise<PurgeResult | null> {
    const { rows: patientRows } = await this.db.query<{ is_test: boolean }>(
      // Sem filtro de `deleted_at`: a trava é `is_test`. Filtrar aqui tornaria
      // inalcançável todo registro que a versão soft já marcou (404 eterno).
      `SELECT is_test FROM patients WHERE id = $1`,
      [patientId],
    );
    if (patientRows.length === 0) return null;
    if (!patientRows[0].is_test) throw new NotATestPatientError(patientId);

    const { rows: appointments } = await this.db.query<AppointmentRow>(
      `SELECT id, country, calendar_event_id
         FROM admission_appointments
        WHERE patient_id = $1`,
      [patientId],
    );

    let calendarEventsDeleted = 0;
    let calendarEventsFailed = 0;
    for (const appt of appointments) {
      if (!appt.calendar_event_id || !appt.country) continue;
      try {
        const calendarId = this.resolveCalendarId(appt.country as AdmissionCountry);
        await this.calendar.deleteEvent(calendarId, appt.calendar_event_id, this.impersonateEmail);
        calendarEventsDeleted += 1;
      } catch (err) {
        calendarEventsFailed += 1;
        functions.logger.warn('patient.test_purge.calendar_delete_failed', {
          patientId,
          appointmentId: appt.id,
          eventId: appt.calendar_event_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const client = await this.db.connect();
    let appointmentsCancelled = 0;
    let vacanciesDeleted = 0;
    try {
      await client.query('BEGIN');

      const appt = await client.query(
        `DELETE FROM admission_appointments WHERE patient_id = $1`,
        [patientId],
      );
      appointmentsCancelled = appt.rowCount ?? 0;

      // FK NO ACTION: a vaga precisa sair antes do paciente, ou o DELETE aborta.
      const vac = await client.query(
        `DELETE FROM job_postings WHERE patient_id = $1`,
        [patientId],
      );
      vacanciesDeleted = vac.rowCount ?? 0;

      await client.query(`DELETE FROM patients WHERE id = $1`, [patientId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const result: PurgeResult = {
      patientId,
      appointmentsCancelled,
      calendarEventsDeleted,
      calendarEventsFailed,
      vacanciesDeleted,
    };
    functions.logger.info('patient.test_purge.done', result);
    return result;
  }

  /** Mesma resolução por env do AdmissionSchedulingService (calendário por país). */
  private resolveCalendarId(country: AdmissionCountry): string {
    const cfg = getAdmissionCountryConfig(country);
    const calendarId = process.env[cfg.admissionCalendarIdEnv];
    if (!calendarId) {
      throw new Error(`missing env ${cfg.admissionCalendarIdEnv} for country ${country}`);
    }
    return calendarId;
  }
}
