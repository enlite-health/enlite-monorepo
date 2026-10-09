/**
 * admissionTime — data/hora da aba Admissão (spec 049, F7), SEMPRE no fuso do país do PACIENTE.
 *
 * Por que não `dateTimeFormat.formatInstant`: ele converte tudo para Buenos Aires (fuso do operador). A aba
 * mostra a reunião no fuso do país do paciente (AR ou BR), que é onde a família a vê.
 *
 * ⚠️ Hoje AR, BR e UY têm o mesmo offset (-03): na máquina de dev (São Paulo) o fuso certo e o fuso errado
 * imprimem a MESMA hora. A prova de que o fuso é explícito está nos testes (fuso "Asia/Tokyo" passado pelo
 * chamador e `timeZone` lido do `Intl`), não na saída formatada de AR/BR.
 *
 * "Hora de parede" = `YYYY-MM-DDTHH:mm` sem offset. É o que a pessoa digita e o que `POST .../admission-appointments`
 * recebe em `slotStartISO`: o servidor a interpreta no fuso do país (nunca o navegador, nunca `Date` local).
 */
import { COUNTRY_TIME_ZONE } from '@presentation/utils/countryTimeZone';

/** Fuso de um país; desconhecido → Buenos Aires (o operador é argentino) em vez de cair no fuso do navegador. */
export function timeZoneForCountry(country: string | null | undefined): string {
  return COUNTRY_TIME_ZONE[country ?? ''] ?? COUNTRY_TIME_ZONE.AR;
}

/** Janela do painel (REQ-05): a reunião (60 min) começa a partir das 08:00 e termina até as 22:00. */
export const ADMISSION_FIRST_START = '08:00';
export const ADMISSION_LAST_START = '21:00';

const pad = (n: number): string => String(n).padStart(2, '0');

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts | null {
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const out = { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
  return Object.values(out).some(Number.isNaN) ? null : out;
}

/** O instante no relógio de parede do fuso, como `YYYY-MM-DDTHH:mm`. `null` se `iso` for inválido. */
export function wallClockIn(iso: string | Date, timeZone: string): string | null {
  const p = zonedParts(iso instanceof Date ? iso : new Date(iso), timeZone);
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}` : null;
}

const MONTH_ABBR_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTH_ABBR_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** "12 de oct. 15:30" — mês por tabela própria (o ICU do runtime varia), hora em 24h. */
export function formatSlotIn(iso: string, timeZone: string, language: string): string {
  const p = zonedParts(new Date(iso), timeZone);
  if (!p) return iso;
  const months = language.toLowerCase().startsWith('pt') ? MONTH_ABBR_PT : MONTH_ABBR_ES;
  return `${p.day} de ${months[p.month - 1]}. ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "15:30" no fuso. */
export function formatTimeIn(iso: string, timeZone: string): string {
  const p = zonedParts(new Date(iso), timeZone);
  return p ? `${pad(p.hour)}:${pad(p.minute)}` : iso;
}

/** Hora de parede "agora" no fuso — o ponto de comparação do "horário passado" do modal. */
export function wallClockNow(timeZone: string, now: Date = new Date()): string {
  return wallClockIn(now, timeZone) ?? '';
}

/** `date` (`YYYY-MM-DD`) + `time` (`HH:mm`) → hora de parede para o servidor; `null` se algum faltar/for inválido. */
export function toWallClock(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  return `${date}T${time}`;
}

export type SlotProblem = 'incomplete' | 'outside_window' | 'in_past';

/** Valida o que dá para validar na tela (janela 8h-22h, horário futuro); o servidor continua sendo a palavra final. */
export function slotProblem(date: string, time: string, timeZone: string, now: Date = new Date()): SlotProblem | null {
  const wall = toWallClock(date, time);
  if (!wall) return 'incomplete';
  if (time < ADMISSION_FIRST_START || time > ADMISSION_LAST_START) return 'outside_window';
  if (wall <= wallClockNow(timeZone, now)) return 'in_past';
  return null;
}

/** A reunião ainda não terminou (usa o instante, não o relógio do navegador no fuso errado). */
export function isFuture(slotEndISO: string, now: Date = new Date()): boolean {
  const end = new Date(slotEndISO).getTime();
  return !Number.isNaN(end) && end > now.getTime();
}
