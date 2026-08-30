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

// ── No fuso de uma vaga (mig 180) — a hora que a pessoa vive, não UTC ─────────
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
