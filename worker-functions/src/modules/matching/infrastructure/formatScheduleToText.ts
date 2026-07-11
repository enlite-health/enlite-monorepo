import { normalizeSchedule } from './scheduleNormalizer';

/**
 * Deriva um texto legível em espanhol a partir do JSONB `job_postings.schedule`
 * (ex: "Lunes 09:00-12:00, Martes 09:00-12:00, ..."). Usado como fallback
 * público para `schedule_days_hours` (coluna legada) quando ela está NULL —
 * caso de vagas novas que nunca vieram do import ClickUp.
 *
 * Reusa `normalizeSchedule` (mesma lógica de forma array vs objeto-por-dia
 * já usada pelo frontend) pra não duplicar a normalização do JSONB. Ordena
 * sempre lunes → domingo, independente da ordem de entrada no JSONB.
 *
 * Lógica pura (sem I/O) — entrada inesperada (string, número, array sem
 * dayOfWeek válido, slot sem start/end) nunca lança; retorna `null`.
 */

const DAY_ORDER = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

const DAY_LABELS: Record<string, string> = {
  lunes: 'Lunes',
  martes: 'Martes',
  miercoles: 'Miércoles',
  jueves: 'Jueves',
  viernes: 'Viernes',
  sabado: 'Sábado',
  domingo: 'Domingo',
};

export function formatScheduleToText(schedule: unknown): string | null {
  const normalized = normalizeSchedule(schedule);
  if (!normalized || typeof normalized !== 'object') return null;

  const parts: string[] = [];
  for (const day of DAY_ORDER) {
    const slots = (normalized as Record<string, unknown>)[day];
    if (!Array.isArray(slots)) continue;

    for (const slot of slots) {
      if (!slot || typeof slot !== 'object') continue;
      const { start, end } = slot as { start?: unknown; end?: unknown };
      if (typeof start !== 'string' || typeof end !== 'string') continue;
      parts.push(`${DAY_LABELS[day]} ${start}-${end}`);
    }
  }

  return parts.length > 0 ? parts.join(', ') : null;
}
