import { projectPatientClinicalForActor } from '../application/patientClinicalAccess';
import { projectContractedServiceForActor } from '../application/contractedServiceHourlyValueAccess';
import { computePatientCompleteness, type PatientCompletenessResult } from '../domain/PatientCompleteness';
import type { PatientListRow } from '../infrastructure/PatientQueryRows';

/**
 * AdminPatientView — o que a API do painel PUBLICA sobre um paciente: a projeção da lista e a
 * da ficha, com as redações de acesso já aplicadas.
 *
 * Extraído de `AdminPatientsController` para manter aquele arquivo dentro do teto de 400 linhas
 * do `CLAUDE.md`. Mesmo papel (e mesmo endereço no módulo) de
 * `@modules/diagnosis/interfaces/DiagnosisPublicView`: um lugar só decide o formato público.
 *
 * Nada de comportamento mudou de lugar: mesmos campos, mesmos defaults, mesma ordem, mesmo
 * ponto ÚNICO de redação do texto clínico (D211.2) e do `hourlyValue` (lex C-c.4). O que NÃO
 * está aqui, de propósito: as trilhas de leitura (`patient_clinical.read`,
 * `patient_lead_contact.read`), que dependem do `req` e continuam no controller.
 */

/** Uma linha da listagem/Kanban. `missing[]` NUNCA sai por aqui (lex D1.1). */
export function toAdminPatientListItem(row: PatientListRow) {
  return {
    id: row.id,
    clickupTaskId: row.clickupTaskId,
    firstName: row.firstName,
    lastName: row.lastName,
    diagnosis: row.diagnosis,
    dependencyLevel: row.dependencyLevel,
    clinicalSpecialty: row.clinicalSpecialty,
    serviceType: row.serviceType ?? [],
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    sex: row.sex,
    status: row.status,
    // Spec 012: o Kanban lê o funil de admissão (mig 313), não o estado clínico v2.
    admissionStatus: row.admissionStatus,
    needsAttention: row.needsAttention,
    isTest: row.isTest,
    attentionReasons: row.attentionReasons,
    addressesCount: row.addressesCount,
    caseNumber: row.caseNumber,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // SLA de inatividade (Fase 4) — o kanban lê isto. Aditivo.
    stageEnteredAt: row.stageEnteredAt ?? null,
    hoursInStage: row.hoursInStage ?? null,
    slaThresholdHours: row.slaThresholdHours ?? null,
    slaBreached: row.slaBreached ?? false,
    // Quem responde pelo paciente. A lista mostra "Responsável: X" onde
    // mostraria o nome, enquanto o paciente não tiver o dele (D249).
    responsibleName: row.responsibleName ?? null,
    // Desempate do lead sem nome — JÁ mascarado pelo repositório (lex C1).
    // Ausente (null) em toda ficha com nome real (lex C2).
    leadContactEmailMasked: row.leadContactEmailMasked ?? null,
    leadContactIsResponsible: row.leadContactIsResponsible ?? false,
  };
}

/**
 * A ficha, com as duas redações aplicadas na MESMA passada:
 *   - texto clínico restrito → ponto único (D211.2), por célula;
 *   - `hourlyValue` de cada serviço contratado → por papel (lex C-c.4), campo por campo.
 */
export function projectAdminPatientDetail(
  patient: Record<string, unknown>,
  cells: readonly string[] | null | undefined,
  roles: readonly string[] | null | undefined,
): Record<string, unknown> {
  const clinicalProjected = projectPatientClinicalForActor(patient, cells);
  const rawServices = (clinicalProjected as { contractedServices?: unknown[] }).contractedServices;
  return Array.isArray(rawServices)
    ? {
        ...clinicalProjected,
        contractedServices: rawServices.map((s) => projectContractedServiceForActor(s as { hourlyValue: number | null }, roles)),
      }
    : clinicalProjected;
}

/**
 * Spec 014 (US-D1, lex D1.1): `completeness` SÓ na ficha — a lista e o kanban continuam com
 * `needsAttention` booleano + `attentionReasons` (enum fechado), nunca `missing`. Mesma função
 * (`computePatientCompleteness`) que decide o gate de `POST /activate` — nunca uma cópia da
 * regra (`ActivatePatientUseCase`).
 */
export function patientDetailCompleteness(patient: unknown): PatientCompletenessResult {
  const detail = patient as {
    birthDate: string | Date | null;
    hasConsent: boolean | null;
    insuranceInformed: string | null;
    addresses?: Array<{ id: string }>;
    responsibles?: unknown[];
    contractedServices?: Array<{ active: boolean; addressId: string | null }>;
  };
  const addresses = Array.isArray(detail.addresses) ? detail.addresses : [];
  const activeServices = Array.isArray(detail.contractedServices)
    ? detail.contractedServices.filter((s) => s.active)
    : [];
  // Migration 330: `addresses` da ficha já vem SÓ com os não arquivados (mapAddresses) — serviço
  // apontando para endereço arquivado cai aqui como "sem endereço", igual ao gate do activate.
  const liveAddressIds = new Set(addresses.map((a) => a.id));
  return computePatientCompleteness({
    birthDate: detail.birthDate,
    hasConsent: detail.hasConsent,
    insuranceInformed: detail.insuranceInformed,
    activeAddressCount: addresses.length,
    activeResponsibleCount: Array.isArray(detail.responsibles) ? detail.responsibles.length : 0,
    activeContractedServiceCount: activeServices.length,
    activeContractedServicesWithoutAddressCount: activeServices.filter(
      (s) => s.addressId == null || !liveAddressIds.has(s.addressId),
    ).length,
  });
}
