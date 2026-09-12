import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { ContractedServiceDetail } from './PatientContractedServiceRepository';

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
 * decorado. `hourlyValue` sai CRU daqui — a redação por papel (lex C-c.4) é do controller.
 */

async function fetchContractedServiceChildren(pool: Pool, serviceIds: string[]) {
  if (serviceIds.length === 0) return { devices: [] as any[], providers: [] as any[], liveVacancies: [] as any[] };
  const [devices, providers, liveVacancies] = await Promise.all([
    pool.query(
      `SELECT csd.service_id, csd.device_type
         FROM contracted_service_devices csd
         JOIN device_types d ON d.code = csd.device_type
        WHERE csd.service_id = ANY($1::uuid[])
        ORDER BY d.sort_order, d.code`,
      [serviceIds],
    ),
    pool.query(
      `SELECT csp.id, csp.service_id, csp.worker_id, csp.weekly_hours, csp.active, csp.ended_at,
              csp.country, csp.created_at, csp.updated_at,
              w.first_name_encrypted, w.last_name_encrypted
         FROM contracted_service_providers csp
         JOIN workers w ON w.id = csp.worker_id
        WHERE csp.service_id = ANY($1::uuid[])
        ORDER BY csp.active DESC, csp.created_at ASC`,
      [serviceIds],
    ),
    // Spec 018, PR-6: mesma condição do 409 de `ActivateRecruitmentUseCase` — vaga viva do
    // serviço. Uma linha por serviço (LIMIT via DISTINCT ON) — nunca conta duas vagas do mesmo
    // serviço (não deveria existir, mas o mapper não assume).
    pool.query(
      `SELECT DISTINCT ON (contracted_service_id) contracted_service_id, id
         FROM job_postings
        WHERE contracted_service_id = ANY($1::uuid[]) AND deleted_at IS NULL
        ORDER BY contracted_service_id, created_at ASC`,
      [serviceIds],
    ),
  ]);
  return { devices: devices.rows, providers: providers.rows, liveVacancies: liveVacancies.rows };
}

export async function mapContractedServices(
  serviceRows: any[],
  pool: Pool,
  enc: KMSEncryptionService,
): Promise<ContractedServiceDetail[]> {
  const ids = serviceRows.map((r) => r.id);
  const { devices, providers, liveVacancies } = await fetchContractedServiceChildren(pool, ids);
  const liveVacancyByService = new Map(liveVacancies.map((v) => [v.contracted_service_id, v.id as string]));
  const decryptedProviders = await Promise.all(
    providers.map(async (p) => {
      const [first, last] = await Promise.all([enc.decrypt(p.first_name_encrypted ?? ''), enc.decrypt(p.last_name_encrypted ?? '')]);
      const workerName = [first, last].filter((s) => s && s.length > 0).join(' ') || null;
      return {
        id: p.id,
        serviceId: p.service_id,
        workerId: p.worker_id,
        workerName,
        weeklyHours: p.weekly_hours != null ? Number(p.weekly_hours) : null,
        active: p.active,
        endedAt: p.ended_at,
        country: p.country,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      };
    }),
  );
  return serviceRows.map((r) => ({
    id: r.id,
    patientId: r.patient_id,
    serviceCode: r.service_code,
    professionalProfile: r.professional_profile,
    providersNeeded: r.providers_needed,
    authorizedHours: r.authorized_hours != null ? Number(r.authorized_hours) : null,
    weeklyHours: r.weekly_hours != null ? Number(r.weekly_hours) : null,
    careLocation: r.care_location,
    hourlyValue: r.hourly_value != null ? Number(r.hourly_value) : null,
    startDate: r.start_date,
    contractType: r.contract_type,
    taxCondition: r.tax_condition,
    supervisionFrequency: r.supervision_frequency,
    guardShift: r.guard_shift,
    // Spec 015 (US-A6.1, migration 322): franja etária solicitada do prestador. `SELECT *`
    // (fetchRelated) já traz a coluna nova — só falta espelhar no shape decorado.
    providerAgeBand: r.provider_age_band,
    // Migration 330: ponteiro para o endereço do paciente + horário do encuadre (array, mesmo
    // formato de job_postings.schedule). `SELECT *` já traz as duas colunas.
    addressId: r.address_id,
    schedule: r.schedule,
    liveVacancyId: liveVacancyByService.get(r.id) ?? null,
    active: r.active,
    endedAt: r.ended_at,
    country: r.country,
    deviceTypes: devices.filter((d) => d.service_id === r.id).map((d) => d.device_type),
    providers: decryptedProviders.filter((p) => p.serviceId === r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
