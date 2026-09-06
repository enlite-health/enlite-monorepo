/**
 * patient-detail-a6-helper.ts — semeadura e leitura direta no Postgres do docker para o e2e da
 * spec 015 (US-A6, franja etária solicitada do prestador). Dados SINTÉTICOS. Molde:
 * patient-detail-c-helper.ts (spec 013, bloco C).
 */
import { runSQL, cleanupPatientDeep } from './patient-detail-a-helper';

export { runSQL, cleanupPatientDeep };

/** Paciente PENDING_ADMISSION (ativável), com 1 endereço — o mínimo para o fluxo da A6. */
export function seedActivatablePatientA6(): { patientId: string; addressId: string; stamp: string } {
  const stamp = Date.now().toString().slice(-6);
  const clickupTaskId = `E2E-A6-${stamp}`;
  runSQL(`
    INSERT INTO patients (
      clickup_task_id, first_name, last_name, status, admission_status,
      has_consent, insurance_informed, country, created_at, updated_at
    ) VALUES (
      '${clickupTaskId}', 'A6Franja', 'Servicio${stamp}', 'PENDING_ADMISSION', 'PENDING_ADMISSION',
      true, 'OSDE', 'AR', NOW(), NOW()
    )
  `);
  const patientId = runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`);
  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_type, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
    VALUES ('${patientId}', 'primary', 'Av. A6 999, CABA, AR', 'Av. A6 999, CABA', -34.60, -58.38, 1, 'manual', NOW(), NOW())
  `);
  runSQL(`UPDATE patients SET case_number = ${910000 + Number(stamp) % 90000} WHERE id = '${patientId}'`);
  // Migration 330: o serviço aponta para o endereço — o teste vincula no drawer antes de ativar.
  const addressId = runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' ORDER BY created_at LIMIT 1`);
  return { patientId, addressId, stamp };
}

/**
 * `age_range_min/max` da vaga NASCIDA do serviço `serviceId` (spec 015, US-A6.2) — junta por
 * `contracted_service_id`, molde de `readVacanciesByService` (patient-detail-c-helper.ts).
 */
export function readVacancyAgeRangeForService(
  patientId: string,
  serviceId: string,
): { ageRangeMin: number | null; ageRangeMax: number | null } | null {
  const out = runSQL(
    `SELECT COALESCE(age_range_min::text,'<NULL>') || ':' || COALESCE(age_range_max::text,'<NULL>')
       FROM job_postings
      WHERE patient_id = '${patientId}' AND contracted_service_id = '${serviceId}' AND deleted_at IS NULL`,
  );
  if (!out) return null;
  const [min, max] = out.split(':');
  return {
    ageRangeMin: min === '<NULL>' ? null : Number(min),
    ageRangeMax: max === '<NULL>' ? null : Number(max),
  };
}

export function readProviderAgeBand(serviceId: string): string | null {
  const out = runSQL(`SELECT COALESCE(provider_age_band, '<NULL>') FROM patient_contracted_services WHERE id = '${serviceId}'`);
  return out === '<NULL>' ? null : out;
}
