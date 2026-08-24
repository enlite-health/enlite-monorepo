/**
 * Translates ClickUp "Estado de Pacientes" task status to canonical Enlite status values.
 *
 * ClickUp has ONE status per task, shared by paciente and vaga.
 * Enlite stores them separately:
 *   - patients.status  → PatientStatus  (migration 143)
 *   - job_postings.status → JobPostingStatus
 *
 * Source of truth: memory project_status_clickup_vs_enlite.md (2026-04-24)
 *
 * Special case: jobPostingStatus=null means "no vacancy exists yet" (e.g. admisión).
 * ClickUpVacancyMapper.map() returns [] when jobPostingStatus is null.
 */

import type { PatientStatus } from '../../../../case/domain/enums/PatientStatus';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

export interface VacancyStatusMapping {
  patientStatus: PatientStatus;
  /**
   * Canonical job_posting status.
   * null means the patient is in a state where no job posting exists yet
   * (e.g. 'admisión' — patient in onboarding, vacancy not created).
   * ClickUpVacancyMapper.map() returns [] when this is null.
   */
  jobPostingStatus: string | null;
}

/**
 * Maps a ClickUp task status (lowercase) to the dual Enlite status pair.
 * Keys must be lowercased before lookup.
 */
export const CLICKUP_TO_VACANCY_STATUS: Record<string, VacancyStatusMapping> = {
  // ClickUp: "Activación pendiente"
  'activación pendiente':   { patientStatus: 'ACTIVE', jobPostingStatus: 'PENDING_ACTIVATION' },
  // ClickUp: "Activo"
  'activo':                 { patientStatus: 'ACTIVE', jobPostingStatus: 'ACTIVE' },
  // ClickUp: "Admisión" / "admisión" (with or without tilde) / "admision" (no tilde)
  // Patient is in pre-onboarding. No job posting exists yet. VacancyMapper returns [].
  'admisión':               { patientStatus: 'ADMISSION', jobPostingStatus: null },
  'admision':               { patientStatus: 'ADMISSION', jobPostingStatus: null }, // ClickUp: sin tilde
  // ClickUp: "Equipe de resposta rápida" (PT variant)
  'equipe de resposta rápida': { patientStatus: 'ACTIVE', jobPostingStatus: 'RAPID_RESPONSE' },
  // ClickUp: "Equipo de respuesta rapida" (ES variant — con "de")
  'equipo de respuesta rapida': { patientStatus: 'ACTIVE', jobPostingStatus: 'RAPID_RESPONSE' },
  // ClickUp: "Equipo respuesta rápida" (ES variant — sin "de", visto en prod)
  'equipo respuesta rápida': { patientStatus: 'ACTIVE', jobPostingStatus: 'RAPID_RESPONSE' },
  // ClickUp: "Equipo respuesta rapida" (ES variant — sin "de", sin tilde)
  'equipo respuesta rapida': { patientStatus: 'ACTIVE', jobPostingStatus: 'RAPID_RESPONSE' },
  // ClickUp: "Reemplazo"
  'reemplazo':              { patientStatus: 'ACTIVE', jobPostingStatus: 'SEARCHING_REPLACEMENT' },
  // ClickUp: "Reemplazos"
  'reemplazos':             { patientStatus: 'ACTIVE', jobPostingStatus: 'SEARCHING_REPLACEMENT' },
  // ClickUp: "Suspendido Temporariamente" (PT variant)
  'suspendido temporariamente': { patientStatus: 'SUSPENDED', jobPostingStatus: 'SUSPENDED' },
  // ClickUp: "Suspendido Temporalmente" (ES variant)
  'suspendido temporalmente':   { patientStatus: 'SUSPENDED', jobPostingStatus: 'SUSPENDED' },
  // ClickUp: "Baja"
  'baja':                   { patientStatus: 'DISCONTINUED', jobPostingStatus: 'CLOSED' },
  // ClickUp: "Alta"
  'alta':                   { patientStatus: 'DISCHARGED', jobPostingStatus: 'CLOSED' },
  // ClickUp: "En espera" — paciente ativo, vaga pausada por razão operacional
  // (distinto de 'suspendido temporalmente' que é suspensão clínica). Migration 166.
  'en espera':              { patientStatus: 'ACTIVE', jobPostingStatus: 'ON_HOLD' },
  // ClickUp: "Busqueda" (sin tilde)
  'busqueda':               { patientStatus: 'ACTIVE', jobPostingStatus: 'SEARCHING' },
  // ClickUp: "Búsqueda" (con tilde)
  'búsqueda':               { patientStatus: 'ACTIVE', jobPostingStatus: 'SEARCHING' },
  // ClickUp: "Vacante Abierta"
  'vacante abierta':        { patientStatus: 'ACTIVE', jobPostingStatus: 'SEARCHING' },
  // ClickUp: "Vacante Abierto" (gender variant)
  'vacante abierto':        { patientStatus: 'ACTIVE', jobPostingStatus: 'SEARCHING' },
};

export function mapClickUpVacancyStatus(
  clickupStatus: string | null | undefined,
): VacancyStatusMapping | null {
  // Empty is legitimate: the task carries no status. Everything below is NOT.
  if (!clickupStatus) return null;
  const key = clickupStatus.trim().toLowerCase();
  const mapped = CLICKUP_TO_VACANCY_STATUS[key];
  if (mapped === undefined) {
    // Unknown ClickUp label — ops may have added or renamed an option. Log it so it can be mapped.
    // The warning lives HERE (not in the caller) so that BOTH call sites are covered:
    // ClickUpPatientMapper already warned; ClickUpVacancyMapper never did.
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Estado de Pacientes (task status)');
    console.warn('[vacancyStatusMap] Unknown ClickUp label:', { field: 'Estado de Pacientes (task status)', label: key });
    return null;
  }
  return mapped;
}
