/**
 * Formata datetime ISO para data legível (dd/MM) usando UTC.
 */
export function formatDateUTC(datetime: string | Date): string {
  const d = new Date(datetime);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

/**
 * Formata datetime ISO para hora legível (HH:mm) usando UTC.
 */
export function formatTimeUTC(datetime: string | Date): string {
  const d = new Date(datetime);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${min}`;
}

// ── Nomes dos dias em espanhol (índice = getDay(): 0 = domingo) — fonte ÚNICA ──
// Três formas para três usos; derivadas uma da outra para não divergirem.

/** Completo, com acento: mensagens ao usuário ("Horario inválido el miércoles"). */
export const DAY_NAMES_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;

/** Sem acento: CHAVES do `job_postings.schedule` legado/normalizado (`{ miercoles: [...] }`). */
export const DAY_KEYS_ES: readonly string[] = DAY_NAMES_ES.map((d) => d.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

/** Abreviado (3 letras, capitalizado): rótulo dos slots de entrevista ("Mié 07/04 10:00"). */
export const DAY_NAMES_ES_SHORT: readonly string[] = DAY_NAMES_ES.map((d) => d[0].toUpperCase() + d.slice(1, 3));

// ── No fuso de uma vaga (mig 180) — a hora que a pessoa vive, não UTC ─────────
// (import circular com o resolver é só de tipo/função usada em runtime de chamada — nunca em carga)
import { localParts, DEFAULT_TIMEZONE } from '@modules/matching/domain/interviewSlotResolver';

/** dd/MM no fuso (default Argentina). */
export function formatDateInTimezone(datetime: string | Date, timezone?: string | null): string {
  const p = localParts(new Date(datetime), timezone && timezone.trim() !== '' ? timezone : DEFAULT_TIMEZONE);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}`;
}

/** HH:mm no fuso (default Argentina). */
export function formatTimeInTimezone(datetime: string | Date, timezone?: string | null): string {
  const p = localParts(new Date(datetime), timezone && timezone.trim() !== '' ? timezone : DEFAULT_TIMEZONE);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
