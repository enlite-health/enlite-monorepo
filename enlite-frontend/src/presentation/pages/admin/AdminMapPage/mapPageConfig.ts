/**
 * mapPageConfig — o que é DADO na página dos mapas (cores, opções, centro
 * padrão), separado da página para ela caber nas 400 linhas e para o teste
 * afirmar a tabela sem montar React.
 */
import type { TFunction } from 'i18next';
import type { PatientMapPoint, WorkerMapPoint } from '@infrastructure/http/AdminMapApiService';

/** Obelisco (CABA) — a operação é AR; o raio nasce em 25 km (FATO-17 da ata de 22/07). */
export const DEFAULT_CENTER = { lat: -34.6037, lng: -58.3816 };
export const DEFAULT_RADIUS_KM = 25;
export const RADIUS_OPTIONS_KM = [5, 10, 20, 25, 50] as const;
export const DEFAULT_COUNTRY = 'AR' as const;
/** Raio para listar pacientes no seletor "centrar en paciente" (escopo obrigatório, lex C3). */
export const PATIENT_PICKER_RADIUS_KM = 100;

export const WORKER_STATUS_COLOR: Record<string, string> = {
  REGISTERED: '#16a34a',
  INCOMPLETE_REGISTER: '#d97706',
  DISABLED: '#6b7280',
};

export const PATIENT_STATUS_COLOR: Record<string, string> = {
  ACTIVE: '#16a34a',
  ADMISSION: '#2563eb',
  PENDING_ADMISSION: '#2563eb',
  SOLICITANTE: '#7c3aed',
  SUSPENDED: '#d97706',
  DISCONTINUED: '#6b7280',
  DISCHARGED: '#6b7280',
};

export const PROFESSIONS = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
export const PATIENT_STATUSES = ['ACTIVE', 'ADMISSION', 'PENDING_ADMISSION', 'SOLICITANTE', 'SUSPENDED', 'DISCONTINUED', 'DISCHARGED'] as const;

export function workerStatusLabel(t: TFunction, status: string | null): string {
  if (!status) return t('admin.map.status.unknown', 'Sin estado');
  const fallback: Record<string, string> = { REGISTERED: 'Documentación completa', INCOMPLETE_REGISTER: 'Registro incompleto', DISABLED: 'Dado de baja' };
  return t(`admin.map.workerStatus.${status}`, fallback[status] ?? status);
}

export function patientStatusLabel(t: TFunction, status: string | null): string {
  if (!status) return t('admin.map.status.unknown', 'Sin estado');
  const fallback: Record<string, string> = {
    ACTIVE: 'Activo', ADMISSION: 'En admisión', PENDING_ADMISSION: 'Esperando financiero', SOLICITANTE: 'Solicitante',
    SUSPENDED: 'Suspendido', DISCONTINUED: 'Baja', DISCHARGED: 'Alta',
  };
  return t(`admin.map.patientStatus.${status}`, fallback[status] ?? status);
}

export function professionLabel(t: TFunction, profession: string | null): string {
  if (!profession) return t('admin.map.profession.unknown', 'Sin profesión');
  const fallback: Record<string, string> = { AT: 'AT', CAREGIVER: 'Cuidador', NURSE: 'Enfermería', KINESIOLOGIST: 'Kinesiología', PSYCHOLOGIST: 'Psicología' };
  return t(`admin.map.profession.${profession}`, fallback[profession] ?? profession);
}

export function placeLabel(p: { city: string | null; neighborhood: string | null }): string {
  return [p.neighborhood, p.city].filter(Boolean).join(' · ');
}

export function distanceLabel(km: number | null): string {
  if (km === null) return '';
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function workerPointTitle(t: TFunction, p: WorkerMapPoint): string {
  return [p.name, professionLabel(t, p.profession), workerStatusLabel(t, p.status), placeLabel(p)].filter(Boolean).join(' — ');
}

export function patientPointTitle(t: TFunction, p: PatientMapPoint): string {
  const vac = p.openVacancies > 0 ? t('admin.map.openVacancies', { count: p.openVacancies, defaultValue: '{{count}} vacante(s) abierta(s)' }) : '';
  return [p.name, patientStatusLabel(t, p.status), placeLabel(p), vac].filter(Boolean).join(' — ');
}
