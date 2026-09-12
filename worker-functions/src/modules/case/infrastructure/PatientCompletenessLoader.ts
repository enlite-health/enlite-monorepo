import type { PoolClient } from 'pg';
import {
  computePatientCompleteness,
  type PatientCompletenessResult,
} from '../domain/PatientCompleteness';

/**
 * Carrega os CONTADORES do checklist de um paciente e devolve o veredito.
 *
 * O que mora aqui é leitura, nunca regra: quem decide o que falta continua sendo
 * `computePatientCompleteness` (fonte única, SUP-D1/D255). Este arquivo existe para que a guarda
 * de transição de status (`PatientStatusWriter`) não precisasse de uma TERCEIRA cópia das
 * consultas — `ActivatePatientUseCase` já as faz dentro da sua própria transação (onde também
 * usa as linhas para montar as vagas) e `PatientQueryRepository` as faz como subselects da
 * listagem.
 *
 * Recebe o `PoolClient` de propósito: a guarda roda DENTRO da transação que já segurou a linha
 * do paciente com `FOR UPDATE`. Ler por fora abriria janela entre a checagem e o UPDATE.
 */
export async function loadPatientCompleteness(
  client: PoolClient,
  patientId: string,
): Promise<PatientCompletenessResult> {
  const res = await client.query<{
    birth_date: string | Date | null;
    has_consent: boolean | null;
    insurance_informed: string | null;
    active_address_count: string;
    active_responsible_count: string;
    active_service_count: string;
    services_without_address_count: string;
    services_without_schedule_count: string;
  }>(
    `SELECT
       p.birth_date,
       p.has_consent,
       COALESCE(p.insurance_informed, p.health_insurance_name) AS insurance_informed,
       (SELECT COUNT(*) FROM patient_addresses pa
         WHERE pa.patient_id = p.id AND pa.archived_at IS NULL)      AS active_address_count,
       -- AND pr.active (spec 018, PR-1, FR-004): responsável desativado não conta como
       -- presente — a mesma régua de MISSING_SQL.RESPONSIBLE (PatientCompleteness.ts).
       (SELECT COUNT(*) FROM patient_responsibles pr
         WHERE pr.patient_id = p.id AND pr.active)                   AS active_responsible_count,
       (SELECT COUNT(*) FROM patient_contracted_services pcs
         WHERE pcs.patient_id = p.id AND pcs.active)                 AS active_service_count,
       -- serviço ativo sem endereço VIVO (NULL ou arquivado) — migration 330
       (SELECT COUNT(*) FROM patient_contracted_services pcs
          LEFT JOIN patient_addresses pa
                 ON pa.id = pcs.address_id AND pa.archived_at IS NULL
         WHERE pcs.patient_id = p.id AND pcs.active AND pa.id IS NULL)
                                                                     AS services_without_address_count,
       -- serviço ativo sem horário: NULL ou array vazio (decisão do Gabriel 07/09). O
       -- jsonb_array_length não é redundante — o CHECK pcs_schedule_is_array aceita '[]'.
       (SELECT COUNT(*) FROM patient_contracted_services pcs
         WHERE pcs.patient_id = p.id AND pcs.active
           AND (pcs.schedule IS NULL OR jsonb_array_length(pcs.schedule) = 0))
                                                                     AS services_without_schedule_count
     FROM patients p
    WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [patientId],
  );

  const row = res.rows[0];
  if (!row) {
    throw new Error(`Patient not found: ${patientId}`);
  }

  return computePatientCompleteness({
    birthDate: row.birth_date,
    hasConsent: row.has_consent,
    insuranceInformed: row.insurance_informed,
    activeAddressCount: Number(row.active_address_count),
    activeResponsibleCount: Number(row.active_responsible_count),
    activeContractedServiceCount: Number(row.active_service_count),
    activeContractedServicesWithoutAddressCount: Number(row.services_without_address_count),
    activeContractedServicesWithoutScheduleCount: Number(row.services_without_schedule_count),
  });
}
