/**
 * ServiceTeamReader — quadro C (Servicio Contratado), Fase 10, DX-10.5.
 *
 * `read` roda dentro de `inPatientTransaction` (RLS de país; memória
 * `connect-cru-sem-actor-context-da-500`), pool pego DENTRO da função (nada no construtor).
 * `readWith` é a query pura — separada para que `ServiceTeamMarkUseCase` (P9) a chame de novo
 * NO MESMO client, dentro da própria transação de escrita (`read` público só abre a transação e
 * delega).
 *
 * UMA consulta só, no client da transação: `svc` (existência do serviço + país do paciente), `live` (a vaga viva,
 * fonte única `liveVacancySql.ts` — a MESMA da ficha e do Kanban), `cand` (candidatos da vaga viva
 * na etapa `SERVICE_TEAM_ENTRY_STAGE`, constante do domínio — nunca literal aqui), `alloc`
 * (alocações do itinerário, `to_char` para as datas — regra da Fase 7), `marks` (marcas ATIVAS de
 * `contracted_service_rejections` — `reverted_at IS NULL` é filtro do leitor), `subs` (DX-13.5,
 * Fase 13: ausências COM substituto, `patient_itinerary_absence.cancelled_at IS NULL AND
 * substitute_worker_id IS NOT NULL` — SEM filtro de data, quem decide vigência é a derivação com
 * `asOf`, DX-13.3). 0 linhas → serviço inexistente, de outro paciente, ou fora da RLS → `null` (o
 * controller mapeia para 404, sem distinguir: não vaza existência).
 *
 * Nenhuma coluna clínica, de telefone ou de endereço; nenhuma leitura de
 * `contracted_service_providers`/`encuadres`. Sem N+1: nem por prestador, nem por lista.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from '../application/patientTransaction';
import { liveVacancySelect } from './liveVacancySql';
import { liveAbsencePredicate } from './absenceSql';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { SERVICE_TEAM_ENTRY_STAGE } from '../domain/deriveServiceTeam';
import type { ItineraryAssignmentStatus } from '../domain/ServiceCoverageCalculator';

export interface ServiceTeamCandidacyRow {
  workerId: string;
  vacancyId: string;
  stage: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
  /**
   * `workers.occupation` — coluna plana, sem KMS (D445, rodada 2). OPCIONAL pelo MESMO motivo de
   * `allocationId`/`weekday` em `ServiceTeamAssignmentRow` acima (DX-13.5): os dublês/fixtures dos
   * testes vivos de outras fases seguem compilando sem tocar neste passo.
   */
  occupation?: string | null;
}

export interface ServiceTeamAssignmentRow {
  workerId: string;
  serviceId: string;
  vacancyId: string;
  validFrom: string;
  validTo: string | null;
  status: ItineraryAssignmentStatus;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
  /**
   * O horário da alocação (DX-13.5, Fase 13) — a `alloc` CTE deste leitor sempre traz os 4 juntos;
   * OPCIONAIS no tipo para os dublês/fixtures dos testes vivos de outras fases (GetServiceTeamUseCase,
   * ServiceTeamMarkUseCase, serviceTeamPresentation) seguirem compilando sem tocar neste passo.
   */
  allocationId?: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
}

export interface ServiceTeamMarkRow {
  workerId: string;
  serviceId: string;
  rejectReasonCategory: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

/** Ausência COM substituto (DX-13.5, Fase 13) — a `subs` CTE, SEM filtro de data. */
export interface ServiceTeamSubstitutionRow {
  workerId: string;
  serviceId: string;
  vacancyId: string;
  date: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

export interface ServiceTeamRows {
  serviceId: string;
  country: string;
  liveVacancyId: string | null;
  candidacies: ServiceTeamCandidacyRow[];
  assignments: ServiceTeamAssignmentRow[];
  marks: ServiceTeamMarkRow[];
  /** OPCIONAL pelo mesmo motivo dos 4 campos de `ServiceTeamAssignmentRow` acima (DX-13.5). */
  substitutions?: ServiceTeamSubstitutionRow[];
}

interface CandJson {
  worker_id: string;
  vacancy_id: string;
  stage: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  occupation: string | null;
}

interface AllocJson {
  worker_id: string;
  service_id: string;
  vacancy_id: string;
  valid_from: string;
  valid_to: string | null;
  status: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  allocation_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

interface MarkJson {
  worker_id: string;
  service_id: string;
  reject_reason_category: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

interface SubsJson {
  worker_id: string;
  service_id: string;
  vacancy_id: string;
  date: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

interface ServiceTeamJoinRow {
  service_id: string;
  country: string;
  live_vacancy_id: string | null;
  candidacies: CandJson[];
  assignments: AllocJson[];
  marks: MarkJson[];
  substitutions: SubsJson[];
}

export class ServiceTeamReader {
  async read(patientId: string, serviceId: string): Promise<ServiceTeamRows | null> {
    return inPatientTransaction((client) => this.readWith(client, patientId, serviceId));
  }

  async readWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceTeamRows | null> {
    const res = await client.query<ServiceTeamJoinRow>(
      `WITH svc AS (
         SELECT pcs.id, p.country FROM patient_contracted_services pcs
           JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL
          WHERE pcs.id = $2 AND pcs.patient_id = $1
       ), live AS (
         ${liveVacancySelect('jp.contracted_service_id = $2')}
       ), cand AS (
         SELECT wja.worker_id, wja.job_posting_id AS vacancy_id, wja.application_funnel_stage AS stage,
                w.first_name_encrypted, w.last_name_encrypted, w.occupation
           FROM worker_job_applications wja JOIN live ON live.id = wja.job_posting_id JOIN workers w ON w.id = wja.worker_id
          WHERE wja.application_funnel_stage = $3 AND ${excludeDisabledWorkersSql('w')}
       ), alloc AS (
         SELECT a.worker_id, s.contracted_service_id AS service_id, wja.job_posting_id AS vacancy_id,
                to_char(a.valid_from,'YYYY-MM-DD') AS valid_from, to_char(a.valid_to,'YYYY-MM-DD') AS valid_to, a.status,
                w.first_name_encrypted, w.last_name_encrypted,
                a.id AS allocation_id, s.weekday, to_char(s.start_time,'HH24:MI') AS start_time, to_char(s.end_time,'HH24:MI') AS end_time
           FROM patient_itinerary_assignment a
           JOIN patient_itinerary_slot s ON s.id = a.slot_id AND s.contracted_service_id = $2
           JOIN worker_job_applications wja ON wja.id = a.application_id
           JOIN workers w ON w.id = a.worker_id
       ), marks AS (
         SELECT r.worker_id, r.service_id, r.reject_reason_category, w.first_name_encrypted, w.last_name_encrypted
           FROM contracted_service_rejections r JOIN workers w ON w.id = r.worker_id
          WHERE r.service_id = $2 AND r.reverted_at IS NULL
       ), subs AS (
         SELECT ab.substitute_worker_id AS worker_id, s.contracted_service_id AS service_id, wja.job_posting_id AS vacancy_id,
                to_char(ab.on_date, 'YYYY-MM-DD') AS date, w.first_name_encrypted, w.last_name_encrypted
           FROM patient_itinerary_absence ab
           JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
           JOIN patient_itinerary_slot s ON s.id = a.slot_id AND s.contracted_service_id = $2
           JOIN worker_job_applications wja ON wja.id = ab.substitute_application_id
           JOIN workers w ON w.id = ab.substitute_worker_id
          WHERE ${liveAbsencePredicate('ab', 'a')} AND ab.substitute_worker_id IS NOT NULL
       )
       SELECT svc.id AS service_id, svc.country, (SELECT id FROM live) AS live_vacancy_id,
              COALESCE((SELECT json_agg(cand) FROM cand), '[]'::json) AS candidacies,
              COALESCE((SELECT json_agg(alloc) FROM alloc), '[]'::json) AS assignments,
              COALESCE((SELECT json_agg(marks) FROM marks), '[]'::json) AS marks,
              COALESCE((SELECT json_agg(subs) FROM subs), '[]'::json) AS substitutions
         FROM svc`,
      [patientId, serviceId, SERVICE_TEAM_ENTRY_STAGE],
    );

    if ((res.rowCount ?? 0) === 0) return null;
    const row = res.rows[0];

    return {
      serviceId: row.service_id,
      country: row.country,
      liveVacancyId: row.live_vacancy_id,
      candidacies: row.candidacies.map((c) => ({
        workerId: c.worker_id,
        vacancyId: c.vacancy_id,
        stage: c.stage,
        firstNameEncrypted: c.first_name_encrypted,
        lastNameEncrypted: c.last_name_encrypted,
        occupation: c.occupation,
      })),
      assignments: row.assignments.map((a) => ({
        workerId: a.worker_id,
        serviceId: a.service_id,
        vacancyId: a.vacancy_id,
        validFrom: a.valid_from,
        validTo: a.valid_to,
        status: a.status as ItineraryAssignmentStatus,
        firstNameEncrypted: a.first_name_encrypted,
        lastNameEncrypted: a.last_name_encrypted,
        allocationId: a.allocation_id,
        weekday: a.weekday,
        startTime: a.start_time,
        endTime: a.end_time,
      })),
      marks: row.marks.map((m) => ({
        workerId: m.worker_id,
        serviceId: m.service_id,
        rejectReasonCategory: m.reject_reason_category,
        firstNameEncrypted: m.first_name_encrypted,
        lastNameEncrypted: m.last_name_encrypted,
      })),
      substitutions: row.substitutions.map((s) => ({
        workerId: s.worker_id,
        serviceId: s.service_id,
        vacancyId: s.vacancy_id,
        date: s.date,
        firstNameEncrypted: s.first_name_encrypted,
        lastNameEncrypted: s.last_name_encrypted,
      })),
    };
  }
}
