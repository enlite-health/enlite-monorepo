/**
 * interviewSlotResolver — os horários que o convite de entrevista OFERECE.
 *
 * Uma vaga tem até 3 slots FIXOS (`meet_link_N`/`meet_datetime_N`, mig 098) e,
 * desde a mig 291, UM slot RECORRENTE semanal (dia + hora LOCAL + sala). A
 * oferta é a união dos fixos futuros com as próximas ocorrências do
 * recorrente, ordenada, cortada em 3 (o template Twilio tem 3 botões).
 *
 * Determinismo: `asOf` é a "hora da oferta". O clique no botão (dias depois)
 * recomputa a MESMA oferta passando o `created_at` da mensagem — por isso o
 * índice do botão continua apontando para a ocorrência que a pessoa viu.
 *
 * Fuso: tudo formatado e calculado no `timezone` da vaga (mig 180), nunca em
 * UTC — "21h de Buenos Aires é meia-noite em UTC" (interviewSchedule.ts).
 * Sem biblioteca de fuso: `Intl.DateTimeFormat` resolve o offset por instante,
 * o que cobre o horário de verão de São Paulo/Buenos Aires.
 */

export interface VacancySlotSource {
  meet_link_1?: string | null; meet_datetime_1?: string | Date | null;
  meet_link_2?: string | null; meet_datetime_2?: string | Date | null;
  meet_link_3?: string | null; meet_datetime_3?: string | Date | null;
  meet_recurring_weekday?: number | null;
  /** 'HH:MM' ou 'HH:MM:SS' (TIME do Postgres). */
  meet_recurring_time?: string | null;
  meet_recurring_link?: string | null;
  timezone?: string | null;
}

export interface OfferedSlot {
  /** 1..3 — posição na mensagem (botão slot_N). */
  index: number;
  link: string;
  /** Instante (UTC) da reunião. */
  datetime: Date;
  /** Ex.: "Lun 07/04 08:30" — no fuso da vaga. */
  label: string;
  source: 'fixed' | 'recurring';
}

import { DAY_NAMES_ES_SHORT } from '@shared/utils/dateFormatters';

export const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';
const MAX_SLOTS = 3;
/** Quantas ocorrências do recorrente entram na oferta (os fixos preenchem o resto). */
const RECURRING_OCCURRENCES = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Partes LOCAIS (no fuso) de um instante.
 *
 * Com `en-US` e as opções acima o Intl SEMPRE devolve as 6 partes, com o
 * weekday em inglês abreviado — então faltar parte é defeito do runtime
 * (ICU sem dados, fuso inválido não lança aqui), não um caso de negócio.
 * Por isso não há fallback silencioso (`?? ''` mascararia um "NaN/NaN 00:00"
 * no convite): falta de parte LANÇA, e o evento fica `failed` com a causa.
 */
export function localParts(instant: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(instant);
  const get = (type: string): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`Intl.DateTimeFormat sem a parte "${type}" para o fuso ${tz}`);
    return value;
  };
  const weekday = WEEKDAY_INDEX[get('weekday')];
  if (weekday === undefined) throw new Error(`Intl.DateTimeFormat devolveu weekday desconhecido para o fuso ${tz}`);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday,
  };
}

/**
 * Instante (UTC) de uma data+hora LOCAL no fuso. Chuta o instante como se
 * fosse UTC, mede o offset real nesse instante e corrige — duas passadas
 * cobrem a transição de horário de verão.
 */
export function zonedLocalToInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const diff = asUtc - guess; // offset do fuso nesse instante
    guess = Date.UTC(y, m - 1, d, hh, mm, 0, 0) - diff;
  }
  return new Date(guess);
}

/** "Lun 07/04 08:30" no fuso. */
export function formatSlotLabel(instant: Date, tz: string = DEFAULT_TIMEZONE): string {
  const p = localParts(instant, tz);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  const hh = String(p.hour).padStart(2, '0');
  const mi = String(p.minute).padStart(2, '0');
  return `${DAY_NAMES_ES_SHORT[p.weekday]} ${dd}/${mm} ${hh}:${mi}`;
}

function parseTime(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(time.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/**
 * Próximas `count` ocorrências de "toda semana no `weekday` às `time`" no
 * fuso, estritamente DEPOIS de `from`. Anda dia a dia no calendário local
 * (até 2 semanas) — sem aritmética de 7×24h, que erra no horário de verão.
 */
export function nextWeeklyOccurrences(
  weekday: number,
  time: string,
  tz: string,
  from: Date,
  count: number,
): Date[] {
  const t = parseTime(time);
  if (!t || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 || count <= 0) return [];
  const out: Date[] = [];
  const start = localParts(from, tz);
  // Cursor: meio-dia local do dia de `from`, avançando 24h — o meio-dia nunca
  // cai na hora inexistente/duplicada da troca de horário.
  let cursor = zonedLocalToInstant(start.year, start.month, start.day, 12, 0, tz).getTime();
  for (let i = 0; i < 7 * (count + 1) && out.length < count; i++) {
    const p = localParts(new Date(cursor), tz);
    if (p.weekday === weekday) {
      const instant = zonedLocalToInstant(p.year, p.month, p.day, t.hh, t.mm, tz);
      if (instant.getTime() > from.getTime()) out.push(instant);
    }
    cursor += DAY_MS;
  }
  return out;
}

/**
 * A oferta: fixos futuros ∪ próximas ocorrências do recorrente, ordenada por
 * instante, no máximo 3, reindexada 1..3. Vazia = nada a oferecer (pulo).
 */
export function resolveOfferedSlots(vacancy: VacancySlotSource, asOf: Date = new Date()): OfferedSlot[] {
  const tz = vacancy.timezone && vacancy.timezone.trim() !== '' ? vacancy.timezone : DEFAULT_TIMEZONE;
  const candidates: Array<Omit<OfferedSlot, 'index' | 'label'>> = [];

  for (const n of [1, 2, 3] as const) {
    const link = vacancy[`meet_link_${n}`];
    const dt = vacancy[`meet_datetime_${n}`];
    if (!link || !dt) continue;
    const datetime = new Date(dt);
    if (Number.isNaN(datetime.getTime()) || datetime.getTime() <= asOf.getTime()) continue;
    candidates.push({ link, datetime, source: 'fixed' });
  }

  const { meet_recurring_weekday: wd, meet_recurring_time: time, meet_recurring_link: rlink } = vacancy;
  if (wd !== null && wd !== undefined && time && rlink) {
    for (const datetime of nextWeeklyOccurrences(wd, time, tz, asOf, RECURRING_OCCURRENCES)) {
      candidates.push({ link: rlink, datetime, source: 'recurring' });
    }
  }

  candidates.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
  // Mesmo instante duas vezes (fixo digitado = ocorrência do recorrente) conta uma.
  const dedup = candidates.filter((c, i) => i === 0 || c.datetime.getTime() !== candidates[i - 1].datetime.getTime());

  return dedup.slice(0, MAX_SLOTS).map((c, i) => ({ ...c, index: i + 1, label: formatSlotLabel(c.datetime, tz) }));
}
