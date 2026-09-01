/**
 * mapPageConfig — o que é DADO na página dos mapas (cores, opções, centro
 * padrão), separado da página para ela caber nas 400 linhas e para o teste
 * afirmar a tabela sem montar React.
 */
import type { TFunction } from 'i18next';
import type { MapCountry, PatientMapPoint, WorkerMapPoint } from '@infrastructure/http/AdminMapApiService';
import { WORKER_PROFESSIONS } from '@domain/entities/Worker';

/**
 * Onde o mapa nasce em cada país — trocar o país move o centro para cá.
 * AR: Obelisco (CABA) — a operação é AR (FATO-17 da ata de 22/07).
 * BR: Praça da Sé (São Paulo) — sem isto o mapa BR ficava preso em Buenos Aires.
 */
export const DEFAULT_CENTER_BY_COUNTRY: Record<MapCountry, { lat: number; lng: number }> = {
  AR: { lat: -34.6037, lng: -58.3816 },
  BR: { lat: -23.5505, lng: -46.6333 },
};
export const DEFAULT_COUNTRY: MapCountry = 'AR';

/** Comparação por valor — o centro anda por clique e vira objeto novo a cada vez. */
export function sameCenter(a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}
export const DEFAULT_CENTER = DEFAULT_CENTER_BY_COUNTRY[DEFAULT_COUNTRY];
/** O raio nasce em 25 km (FATO-17 da ata de 22/07). */
export const DEFAULT_RADIUS_KM = 25;
export const RADIUS_OPTIONS_KM = [5, 10, 20, 25, 50] as const;

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

/** A fonte é a entidade de domínio — o mapa não mantém lista própria de profissões. */
export const PROFESSIONS = WORKER_PROFESSIONS;
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

/**
 * A linha secundária — profissão/status/lugar. UMA função para a lista e para
 * o balão do pino: quando eram dois trechos iguais em dois lugares, os dois
 * podiam divergir sem ninguém notar.
 */
export function workerDetails(t: TFunction, p: WorkerMapPoint): string {
  const place = placeLabel(p) || (p.lat === null ? t('admin.map.noLocation', 'sin ubicación') : '');
  return [professionLabel(t, p.profession), workerStatusLabel(t, p.status), place].filter(Boolean).join(' · ');
}

export function patientDetails(t: TFunction, p: PatientMapPoint): string {
  const place = placeLabel(p) || (p.lat === null ? t('admin.map.noLocation', 'sin ubicación') : '');
  const vac = p.openVacancies > 0 ? t('admin.map.openVacancies', { count: p.openVacancies, defaultValue: '{{count}} vacante(s) abierta(s)' }) : '';
  return [patientStatusLabel(t, p.status), place, vac].filter(Boolean).join(' · ');
}

/** Tooltip NATIVO do pino (o `title` do marcador), onde só cabe uma linha. */
export function workerPointTitle(t: TFunction, p: WorkerMapPoint): string {
  return [p.name, workerDetails(t, p)].filter(Boolean).join(' — ');
}

export function patientPointTitle(t: TFunction, p: PatientMapPoint): string {
  return [p.name, patientDetails(t, p)].filter(Boolean).join(' — ');
}

/**
 * Legenda das bolinhas — UMA entrada por COR, não por status: `ADMISSION` e
 * `PENDING_ADMISSION` são o mesmo azul, `DISCONTINUED` e `DISCHARGED` o mesmo
 * cinza. Duas entradas com a mesma cor não seriam legenda, seriam enigma.
 */
export function legendEntries(t: TFunction, kind: 'workers' | 'patients'): Array<{ color: string; label: string }> {
  // Percorre o PRÓPRIO mapa de cores (e não a lista de status): assim não
  // existe o caso "status sem cor" — que seria um ramo impossível de testar.
  const colors = kind === 'workers' ? WORKER_STATUS_COLOR : PATIENT_STATUS_COLOR;
  const label = kind === 'workers' ? workerStatusLabel : patientStatusLabel;

  const byColor = new Map<string, string[]>();
  for (const [status, color] of Object.entries(colors)) {
    byColor.set(color, [...(byColor.get(color) ?? []), label(t, status)]);
  }
  return [...byColor].map(([color, labels]) => ({ color, label: labels.join(' / ') }));
}
