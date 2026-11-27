/**
 * Faixa de uma ocorrência de turno em instantes UTC (`starts_at`, `ends_at`). Pura, sem I/O.
 * A MESMA função serve o itinerário do prestador (`WorkerItineraryReader`) e o detector do alerta à coordenação (emenda 077 §5.2):
 * quem decide "quando o turno acaba" é um só.
 */

/** Offset fixo por país (sem horário de verão hoje). País desconhecido cai em AR, único país em operação. */
const UTC_OFFSET_HOURS: Record<string, number> = { AR: -3, BR: -3, UY: -3 };

export interface OccurrenceWindowInput {
  date: string; // YYYY-MM-DD do INÍCIO do turno (hora local do país)
  startTime: string; // HH:MM
  endTime: string; // HH:MM; `endTime <= startTime` = vira a meia-noite (termina no dia seguinte)
  country: string;
}

function toIso(date: string, hhmm: string, country: string, dayShift: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const offset = UTC_OFFSET_HOURS[country] ?? -3;
  return new Date(Date.UTC(y, m - 1, d + dayShift, hh - offset, mm, 0)).toISOString().replace('.000Z', 'Z');
}

export function occurrenceWindowOf(o: OccurrenceWindowInput): { startsAt: string; endsAt: string } {
  const overnight = o.endTime <= o.startTime ? 1 : 0;
  return { startsAt: toIso(o.date, o.startTime, o.country, 0), endsAt: toIso(o.date, o.endTime, o.country, overnight) };
}
