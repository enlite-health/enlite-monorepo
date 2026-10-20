import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { computeScheduleWeeklyHours } from '../../matching/domain/scheduleHours';
import type { ContractedServiceDetail, ContractedServiceScheduleView } from './PatientContractedServiceRepository';
import { fetchLiveVacancies } from './liveVacancyOfService';
import { fetchCurrentAuthorizations, type CurrentAuthorization } from './contractedServiceAuthorizationRead';
import { batchEntry, derivePayerCoverageMatch, payerAtMany, payerHistoryMany } from './contractedServicePayerRead';
import { priceStateMany } from './contractedServicePriceRead';
import type { CoverageEntry } from './patientCoverageRead';

/**
 * ContractedServiceDetailMapper — a SUBÁRVORE de serviços contratados da ficha do paciente.
 *
 * Extraído de `PatientDetailQueryHelper` para manter aquele arquivo dentro do teto de 400
 * linhas (mesmo motivo, e mesmo molde, de `PatientRelatedWriter`). Só FORMA mudou de lugar:
 * as duas queries filhas (dispositivos e prestadores) e a decoração do serviço são o mesmo
 * código, na mesma ordem, com as mesmas colunas.
 *
 * Responsabilidade única: dado o conjunto de linhas de `patient_contracted_services`, buscar
 * os filhos (`contracted_service_devices`, `contracted_service_providers`) e devolver o shape
 * decorado. Preço, nomes do pagador e divergência saem CRUS daqui — a redação por ator (lex C-c.4, spec 058 §0) é de
 * `projectContractedServiceForActor`.
 *
 * Spec 058 (D-44): `payer`/`payerHistory`/`price`/`tax`/`coverageMatch` saem das MESMAS funções em lote que o `decorate` da rota
 * (`PatientContractedServiceRepository`) chama — `payerAtMany`, `payerHistoryMany`, `priceStateMany`, `derivePayerCoverageMatch` —
 * com o `asOf` da ficha: +3 queries por ficha, qualquer que seja o nº de serviços.
 */

/** Horário vigente em `asOf` de CADA serviço pedido — todo id tem entrada (sem faixa = `null`, nunca ausente). Dono único: ficha e rota chamam esta. */
export async function fetchServiceSchedules(
  q: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  serviceIds: string[],
  asOf: string,
): Promise<Map<string, ContractedServiceScheduleView[] | null>> {
  const out = new Map<string, ContractedServiceScheduleView[] | null>(serviceIds.map((id) => [id, null]));
  if (serviceIds.length === 0) return out;
  const { rows } = await q.query(
    `SELECT id, horario_do_servico(id, $2::date) AS schedule FROM patient_contracted_services WHERE id = ANY($1::uuid[])`,
    [serviceIds, asOf],
  );
  for (const r of rows ?? []) out.set(r.id as string, (r.schedule as ContractedServiceScheduleView[] | null) ?? null);
  return out;
}

async function fetchContractedServiceChildren(pool: Pool, serviceIds: string[], asOf: string) {
  if (serviceIds.length === 0) {
    return {
        devices: [] as any[],
        providers: [] as any[],
        schedules: new Map<string, ContractedServiceScheduleView[] | null>(),
        liveVacancies: new Map() as Awaited<ReturnType<typeof fetchLiveVacancies>>,
        authorizations: new Map<string, CurrentAuthorization>(),
        payers: new Map() as Awaited<ReturnType<typeof payerAtMany>>,
        histories: new Map() as Awaited<ReturnType<typeof payerHistoryMany>>,
        prices: new Map() as Awaited<ReturnType<typeof priceStateMany>>,
    };
  }
  const [devices, providers, schedules, liveVacancies, authorizations, payers, histories, prices] = await Promise.all([
    pool.query(
      `SELECT csd.service_id, csd.device_type
         FROM contracted_service_devices csd
         JOIN device_types d ON d.code = csd.device_type
        WHERE csd.service_id = ANY($1::uuid[])
        ORDER BY d.sort_order, d.code`,
      [serviceIds],
    ),
    pool.query(
      `SELECT csp.id, csp.service_id, csp.worker_id, csp.active, csp.ended_at,
              csp.country, csp.created_at, csp.updated_at,
              w.first_name_encrypted, w.last_name_encrypted
         FROM contracted_service_providers csp
         JOIN workers w ON w.id = csp.worker_id
        WHERE csp.service_id = ANY($1::uuid[])
        ORDER BY csp.active DESC, csp.created_at ASC`,
      [serviceIds],
    ),
    // Spec 058 (B1): o horário vigente em `asOf` — dono: `fetchServiceSchedules` (a rota usa a MESMA).
    fetchServiceSchedules(pool, serviceIds, asOf),
    // Spec 018 PR-6 / spec 047 F2: a vaga viva do serviço (id + código + estado + link) — dono: `fetchLiveVacancies`.
    fetchLiveVacancies(pool, serviceIds),
    // Spec 056: a autorização corrente (vigente em `asOf`) — dono: `contracted_service_authorization`.
    fetchCurrentAuthorizations(pool, serviceIds, asOf),
    payerAtMany(pool, serviceIds, asOf),
    payerHistoryMany(pool, serviceIds),
    priceStateMany(pool, serviceIds, asOf),
  ]);
  return { devices: devices.rows, providers: providers.rows, schedules, liveVacancies, authorizations, payers, histories, prices };
}

export async function mapContractedServices(
  serviceRows: any[],
  pool: Pool,
  enc: KMSEncryptionService,
  /** Dia de operação do país do paciente (`operationDateOf(patient.country, requestNow)`). */
  asOf: string,
  /** As coberturas verificadas do paciente, já montadas pela ficha (`coverageEntriesSql`): alimentam a divergência sem query a mais. */
  coverageEntries: readonly CoverageEntry[],
): Promise<ContractedServiceDetail[]> {
  const ids = serviceRows.map((r) => r.id);
  const { devices, providers, schedules, liveVacancies, authorizations, payers, histories, prices } = await fetchContractedServiceChildren(pool, ids, asOf);
  const scheduleById = schedules;
  const decryptedProviders = await Promise.all(
    providers.map(async (p) => {
      const [first, last] = await Promise.all([enc.decrypt(p.first_name_encrypted ?? ''), enc.decrypt(p.last_name_encrypted ?? '')]);
      const workerName = [first, last].filter((s) => s && s.length > 0).join(' ') || null;
      return {
        id: p.id,
        serviceId: p.service_id,
        workerId: p.worker_id,
        workerName,
        active: p.active,
        endedAt: p.ended_at,
        country: p.country,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      };
    }),
  );
  return serviceRows.map((r) => {
    const payer = batchEntry(payers, r.id);
    const priceTax = batchEntry(prices, r.id);
    return {
    id: r.id,
    patientId: r.patient_id,
    serviceCode: r.service_code,
    professionalProfile: r.professional_profile,
    providersNeeded: r.providers_needed,
    authorization: authorizations.get(r.id) ?? null,
    scheduleHours: computeScheduleWeeklyHours(scheduleById.get(r.id) ?? null),
    careLocation: r.care_location,
    startDate: r.start_date,
    supervisionFrequency: r.supervision_frequency,
    guardShift: r.guard_shift,
    // Spec 015 (US-A6.1, migration 322): franja etária solicitada do prestador. `SELECT *`
    // (fetchRelated) já traz a coluna nova — só falta espelhar no shape decorado.
    providerAgeBand: r.provider_age_band,
    // Migration 330: ponteiro para o endereço do paciente. O horário (spec 056) vem de `horario_do_servico`, não da coluna.
    addressId: r.address_id,
    schedule: scheduleById.get(r.id) ?? null,
    // Spec 027 Fase 3 (D507/D508): `SELECT *` já traz as 7 colunas. `worker_attributes`/`daily_obs` são SÓ FICHA.
    requiredProfessions: r.required_professions,
    requiredSex: r.required_sex,
    requiredExperience: r.required_experience,
    workerAttributes: r.worker_attributes,
    workSchedule: r.work_schedule,
    paymentDay: r.payment_day,
    dailyObs: r.daily_obs,
    liveVacancy: liveVacancies.get(r.id) ?? null,
    active: r.active,
    endedAt: r.ended_at,
    country: r.country,
    deviceTypes: devices.filter((d) => d.service_id === r.id).map((d) => d.device_type),
    providers: decryptedProviders.filter((p) => p.serviceId === r.id),
    asOf,
    payer,
    payerHistory: batchEntry(histories, r.id),
    price: priceTax.price,
    tax: priceTax.tax,
    coverageMatch: derivePayerCoverageMatch(payer, coverageEntries),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    };
  });
}
