import type { Pool, PoolClient } from 'pg';
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
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientPhotoStorage } from '../infrastructure/PatientPhotoStorage';
import { PatientDocumentStorage } from '../infrastructure/PatientDocumentStorage';
import { PatientPhotoOrphanRepository } from '../infrastructure/PatientPhotoOrphanRepository';

/** Tentativa de purgar um paciente que NÃO está marcado como teste. */
export class NotATestPatientError extends Error {
  readonly code = 'NOT_A_TEST_PATIENT';
  constructor(patientId: string) {
    super(`Patient ${patientId} is not marked as is_test — refusing to purge`);
    this.name = 'NotATestPatientError';
  }
}

/**
 * A vaga do paciente sintético recebeu candidatura de prestador REAL.
 *
 * `job_postings` tem 11 filhas em ON DELETE CASCADE — entre elas
 * `worker_job_applications` (mig 011:59), `job_posting_audit_log` e
 * `publications` — e mais 6 em SET NULL, que perdem o vínculo em silêncio.
 * Apagar a vaga levaria junto a candidatura de gente de verdade, que nada tem
 * de sintética. Condição C3 do parecer do `lex` (02/09): abortar, nunca podar.
 */
export class TestVacancyHasApplicationsError extends Error {
  readonly code = 'TEST_VACANCY_HAS_APPLICATIONS';
  constructor(patientId: string, readonly applications: number) {
    super(
      `Patient ${patientId} has test vacancies with ${applications} real application(s) — refusing to purge`,
    );
    this.name = 'TestVacancyHasApplicationsError';
  }
}

/** Evidência do que a limpeza realmente fez (o E2E assere em cima disto). */
export interface PurgeResult {
  patientId: string;
  appointmentsCancelled: number;
  calendarEventsDeleted: number;
  calendarEventsFailed: number;
  vacanciesDeleted: number;
  /** Linhas que saíram por ON DELETE CASCADE, por tabela (C2: o log é a única
   *  evidência que resta; contagem sem PII). Aditivo — o e2e-prod lê só os
   *  campos acima. */
  cascaded: Record<string, number>;
  /** spec 018, PR-4 (task 4.8): objetos GCS apagados/falhos — a LINHA some por
   *  CASCADE, mas o objeto do bucket só some se ALGUÉM chamar o storage. */
  photoObjectsDeleted: number;
  photoObjectsFailed: number;
  documentObjectsDeleted: number;
  documentObjectsFailed: number;
}

/** Filhas de `patients` em ON DELETE CASCADE — contadas ANTES do DELETE, porque
 *  depois dele não há o que contar. */
const CASCADE_CHILDREN = [
  'patient_status_history',
  'patient_addresses',
  'patient_responsibles',
  'patient_chat_ids',
  'patient_professionals',
  'patient_field_overrides_audit',
  // Spec 013, bloco C (migration 319): patient_contracted_services é filha DIRETA de patients
  // (ON DELETE CASCADE), contada aqui como as demais. contracted_service_devices e
  // contracted_service_providers são netas — CASCADE a partir do serviço, não de patients — e
  // por isso não têm patient_id próprio para esta contagem; saem juntas mesmo assim (2 níveis
  // de FK ON DELETE CASCADE), só não aparecem no resultado por tabela.
  'patient_contracted_services',
  // Spec 017 (lex C4): as versões do projeto terapêutico são filhas diretas de patients (ON DELETE
  // CASCADE na 416) — o trigger de imutabilidade só deixa a linha sumir quando o pai já não existe,
  // que é exatamente o que o purge faz.
  'patient_therapeutic_projects',
  // 417 (D301): contatos de emergência da cobertura — filha direta, ON DELETE CASCADE.
  'patient_coverage_emergency_contacts',
  // 422 (spec 018, PR-2): contatos externos sem vínculo familiar — filha direta, ON DELETE CASCADE.
  'patient_external_contacts',
  // 426 (spec 018, PR-4): foto, consentimento de imagem e documento de prova — filhas diretas,
  // ON DELETE CASCADE. NOTA (PARCIAL, 14/09): a contagem aqui prova só a linha do banco; o objeto
  // do GCS (foto e documento) ainda NÃO é apagado pela purga nesta sessão — falta a chamada de
  // storage ANTES do DELETE (task 4.8, pendente).
  'patient_documents',
  'patient_image_consents',
  'patient_photos',
] as const;

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
 * As 7 tabelas-filhas em ON DELETE CASCADE (patient_addresses, patient_chat_ids,
 * patient_field_overrides_audit, patient_professionals, patient_responsibles,
 * patient_status_history, patient_contracted_services — spec 013 bloco C) saem junto;
 * contracted_service_devices/contracted_service_providers são NETAS (cascata a partir do
 * serviço) e saem no mesmo DELETE, 2 níveis de FK abaixo. As que são NO ACTION precisam sair ANTES,
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
    // spec 018, PR-4 (task 4.8): FÁBRICAS, não instâncias — `PatientPhotoStorage`/
    // `PatientDocumentStorage` lançam no `new` sem `GCS_PATIENT_*_BUCKET` (fail-closed). Um
    // default `= new PatientPhotoStorage()` aqui quebraria TODOS os testes que constroem este
    // serviço passando só `db`/`calendar` (21 testes existentes, sem env de bucket) — a fábrica só
    // roda quando existe de fato uma foto/documento para apagar (ver `purge`).
    private readonly photoStorageFactory: () => PatientPhotoStorage = () => new PatientPhotoStorage(),
    private readonly documentStorageFactory: () => PatientDocumentStorage = () => new PatientDocumentStorage(),
    private readonly orphanRepo: PatientPhotoOrphanRepository = new PatientPhotoOrphanRepository(),
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
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
  async purge(patientId: string, actorUid: string | null = null): Promise<PurgeResult | null> {
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

    // spec 018, PR-4 (task 4.8): caminhos LIDOS antes do CASCADE apagar as linhas — depois do
    // DELETE não há mais de onde ler `object_path_encrypted`.
    const { rows: photoRows } = await this.db.query<{ object_path_encrypted: string }>(
      `SELECT object_path_encrypted FROM patient_photos WHERE patient_id = $1`,
      [patientId],
    );
    const { rows: documentRows } = await this.db.query<{ object_path_encrypted: string }>(
      `SELECT object_path_encrypted FROM patient_documents WHERE patient_id = $1`,
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
    let cascaded: Record<string, number> = {};
    try {
      await client.query('BEGIN');

      const appt = await client.query(
        `DELETE FROM admission_appointments WHERE patient_id = $1`,
        [patientId],
      );
      appointmentsCancelled = appt.rowCount ?? 0;

      // C3 — a vaga sintética pode ter recebido candidatura de prestador REAL, e
      // `worker_job_applications` sai por CASCADE. Contar ANTES e abortar: perder
      // a candidatura de alguém para limpar fixture é o inverso do objetivo.
      const { rows: appRows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM worker_job_applications
          WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = $1)`,
        [patientId],
      );
      // Fail-CLOSED: sem contagem não se apaga. `?? 0` aqui significaria "não
      // consegui contar, então pode ir" — a regra da casa é o contrário
      // (contagem zero é falha, nunca sucesso). `count(*)` sempre devolve linha;
      // se um dia não devolver, a limpeza para em vez de arriscar.
      const realApplications = appRows[0]?.n;
      if (realApplications == null) {
        throw new Error(
          `Could not count applications for patient ${patientId} vacancies — refusing to purge`,
        );
      }
      if (realApplications > 0) throw new TestVacancyHasApplicationsError(patientId, realApplications);

      // FK NO ACTION: a vaga precisa sair antes do paciente, ou o DELETE aborta.
      const vac = await client.query(
        `DELETE FROM job_postings WHERE patient_id = $1`,
        [patientId],
      );
      vacanciesDeleted = vac.rowCount ?? 0;

      cascaded = await this.countCascadeChildren(client, patientId);

      await client.query(`DELETE FROM patients WHERE id = $1`, [patientId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // spec 018, PR-4 (task 4.8): AGORA que a transação comitou (as linhas já saíram por CASCADE),
    // apaga cada objeto do GCS. Best-effort por objeto, mesmo critério dos eventos de Calendar
    // acima — uma falha vira órfão (`patient_photo_orphans`, retry via
    // `PatientPhotoOrphanRetryService`) e é CONTADA, nunca aborta nem lança.
    let photoObjectsDeleted = 0;
    let photoObjectsFailed = 0;
    for (const row of photoRows) {
      // eslint-disable-next-line no-await-in-loop -- purga de paciente é operação rara e manual/e2e-prod; sequencial de propósito.
      const ok = await this.deleteOrphanCandidate(row.object_path_encrypted, 'PHOTOS');
      if (ok) photoObjectsDeleted += 1; else photoObjectsFailed += 1;
    }
    let documentObjectsDeleted = 0;
    let documentObjectsFailed = 0;
    for (const row of documentRows) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.deleteOrphanCandidate(row.object_path_encrypted, 'DOCUMENTS');
      if (ok) documentObjectsDeleted += 1; else documentObjectsFailed += 1;
    }

    const result: PurgeResult = {
      patientId,
      appointmentsCancelled,
      calendarEventsDeleted,
      calendarEventsFailed,
      vacanciesDeleted,
      cascaded,
      photoObjectsDeleted,
      photoObjectsFailed,
      documentObjectsDeleted,
      documentObjectsFailed,
    };
    // C2 — com o registro fora da tabela, este log é a ÚNICA evidência de que a
    // eliminação aconteceu; sem o ator ele não responde "quem". UUID e contagens
    // apenas: nada de e-mail, telefone ou texto clínico.
    functions.logger.info('patient.test_purge.done', { ...result, actorUid });
    return result;
  }

  /** Conta o que vai sair por CASCADE. Uma query só, dentro da transação. */
  private async countCascadeChildren(
    client: PoolClient,
    patientId: string,
  ): Promise<Record<string, number>> {
    const sql = CASCADE_CHILDREN.map(
      (t) => `SELECT '${t}' AS tabela, count(*)::int AS n FROM ${t} WHERE patient_id = $1`,
    ).join(' UNION ALL ');
    const { rows } = await client.query<{ tabela: string; n: number }>(sql, [patientId]);
    return Object.fromEntries(rows.map((r) => [r.tabela, r.n]));
  }

  /**
   * Apaga UM objeto (foto ou documento) do bucket certo; em falha, grava em
   * `patient_photo_orphans` (`reason='PURGE'`) para o retry pegar depois. Nunca lança — a purga
   * do paciente não pode travar por um objeto individual de storage.
   */
  private async deleteOrphanCandidate(objectPathEncrypted: string, bucket: 'PHOTOS' | 'DOCUMENTS'): Promise<boolean> {
    try {
      const objectPath = await this.enc.decrypt(objectPathEncrypted);
      const storage = bucket === 'PHOTOS' ? this.photoStorageFactory() : this.documentStorageFactory();
      await storage.delete(objectPath);
      return true;
    } catch (err) {
      functions.logger.warn('patient.test_purge.object_delete_failed', { bucket, error: err instanceof Error ? err.message : String(err) });
      try {
        await this.orphanRepo.record(objectPathEncrypted, bucket, 'PURGE');
      } catch (orphanErr) {
        functions.logger.error('patient.test_purge.object_orphan_record_failed', { bucket, error: orphanErr instanceof Error ? orphanErr.message : String(orphanErr) });
      }
      return false;
    }
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
