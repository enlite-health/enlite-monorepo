/**
 * LinkExistingVacancyRepository — SQL do vínculo vaga existente → serviço contratado (spec 079, plan §3.4).
 * TODO método roda no `client` da transação do use case (RLS: query fora dela dá 500). Colunas explícitas,
 * nomes de coluna só de whitelist fixa; só o `client` recebido, nunca o pool.
 */
import type { PoolClient } from 'pg';
import type { VacancyForLink } from '../domain/VacancyLinkEligibility';
import {
  VACANCY_SERVICE_OWNED_COLUMNS,
  type ServiceFeed,
  type ServiceLinkTarget,
  type VacancyLinkSource,
} from '../domain/LinkExistingVacancyPlan';
import { fetchPatientVacancies, type PatientVacancyRow } from './PatientVacanciesQueryHelper';

export type VacancyForLinkRow = VacancyForLink & VacancyLinkSource & { id: string };

/** Chave do ServiceFeed → coluna de `patient_contracted_services`. Whitelist FIXA (nunca interpolar chave de fora). */
const FEED_COLUMNS: ReadonlyArray<readonly [keyof ServiceFeed, string]> = [
  ['required_professions', 'required_professions'],
  ['required_experience', 'required_experience'],
  ['work_schedule', 'work_schedule'],
  ['payment_day', 'payment_day'],
  ['required_sex', 'required_sex'],
  ['providers_needed', 'providers_needed'],
  ['provider_age_band', 'provider_age_band'],
  ['address_id', 'address_id'],
];

interface VacancyRawRow {
  id: string;
  patient_id: string | null;
  contracted_service_id: string | null;
  deleted_at: Date | string | null;
  status: string | null;
  required_professions: string[] | null;
  required_experience: string | null;
  work_schedule: string | null;
  payment_day: string | null;
  required_sex: string | null;
  providers_needed: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  schedule: unknown | null;
  patient_address_id: string | null;
}

export class LinkExistingVacancyRepository {
  /** Reusa o helper da lista de vagas do paciente (sem 2ª query), agora no client da transação. */
  async listPatientVacanciesForLink(client: PoolClient, patientId: string): Promise<PatientVacancyRow[]> {
    return fetchPatientVacancies(client, patientId);
  }

  async readVacancyForLink(
    client: PoolClient,
    vacancyId: string,
    opts: { forUpdate: boolean },
  ): Promise<VacancyForLinkRow | null> {
    const res = await client.query<VacancyRawRow>(
      `SELECT id, patient_id, contracted_service_id, deleted_at, status,
              required_professions, required_experience, work_schedule, payment_day, required_sex,
              providers_needed, age_range_min, age_range_max, schedule, patient_address_id
         FROM job_postings
        WHERE id = $1${opts.forUpdate ? '\n        FOR UPDATE' : ''}`,
      [vacancyId],
    );
    if ((res.rowCount ?? res.rows.length) === 0 || res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      patientId: r.patient_id,
      contractedServiceId: r.contracted_service_id,
      deletedAt: r.deleted_at,
      status: r.status,
      required_professions: r.required_professions,
      required_experience: r.required_experience,
      work_schedule: r.work_schedule,
      payment_day: r.payment_day,
      required_sex: r.required_sex,
      providers_needed: r.providers_needed,
      age_range_min: r.age_range_min,
      age_range_max: r.age_range_max,
      schedule: r.schedule,
      patient_address_id: r.patient_address_id,
    };
  }

  /** Só o que `lockRecruitmentContext` NÃO traz do serviço (a faixa etária). O serviço já está travado por ele. */
  async readServiceLinkTarget(
    client: PoolClient,
    serviceId: string,
  ): Promise<Pick<ServiceLinkTarget, 'provider_age_band'> | null> {
    const res = await client.query<{ provider_age_band: ServiceLinkTarget['provider_age_band'] }>(
      `SELECT provider_age_band FROM patient_contracted_services WHERE id = $1`,
      [serviceId],
    );
    if (res.rows.length === 0) return null;
    return { provider_age_band: res.rows[0].provider_age_band ?? null };
  }

  /**
   * UPDATE só das colunas presentes no feed; feed vazio = nenhuma query. `actorUid` (uid do ator, como
   * `PatientContractedServiceRepository` grava em `updated_by`, NOT NULL) carimba a autoria junto de `updated_at`.
   */
  async feedService(client: PoolClient, serviceId: string, feed: ServiceFeed, actorUid: string): Promise<void> {
    const params: unknown[] = [serviceId];
    const sets: string[] = [];
    for (const [key, column] of FEED_COLUMNS) {
      const value = feed[key];
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) return;
    params.push(actorUid);
    sets.push(`updated_by = $${params.length}`);
    sets.push('updated_at = NOW()');
    await client.query(`UPDATE patient_contracted_services SET ${sets.join(', ')} WHERE id = $1`, params);
  }

  /** UM UPDATE: vincula e zera as 9 colunas do CHECK da migration 525. Devolve o rowCount (0 = perdeu a corrida). */
  async linkVacancyAndClear(client: PoolClient, vacancyId: string, serviceId: string): Promise<number> {
    const clears = VACANCY_SERVICE_OWNED_COLUMNS.map((c) => `${c} = NULL`).join(', ');
    const res = await client.query(
      `UPDATE job_postings
          SET contracted_service_id = $2, ${clears}, updated_at = NOW()
        WHERE id = $1 AND contracted_service_id IS NULL AND deleted_at IS NULL`,
      [vacancyId, serviceId],
    );
    return res.rowCount ?? 0;
  }
}
