/**
 * dateTimeFormat — o ÚNICO lugar do frontend que formata data e hora para a tela.
 *
 * Regra do Gabriel (dono): o banco guarda em UTC, a tela mostra em -03 (Buenos Aires) e sempre em
 * 24h. Três classes de valor, e a classe decide a função — errar a classe é o bug:
 *
 * - INSTANTE (`timestamptz`, `*At`, `*_at`, hora de envio, `meet_datetime`): `formatInstant`.
 *   Converte para `OPERATION_TIME_ZONE`, nunca para o fuso do navegador.
 * - SÓ-DATA (coluna `date`: `interviewDate`, `birthDate`, `startDate`…): `formatCalendarDate`.
 *   NUNCA converte fuso. A API devolve `"2026-10-07T00:00:00.000Z"` (o `pg` do servidor UTC
 *   serializa a `date` como meia-noite UTC) ou `"2026-10-07"`; converter para -03 tira um dia
 *   ("6 oct" para uma entrevista de 7/10). Pega-se `slice(0, 10)` e formata em UTC.
 * - SÓ-HORA (coluna `time`, `HH:MM:SS`): `formatClockTime`, por string, sem `Date`.
 *
 * ⚠️ `hourCycle: 'h23'` e nunca `hour12`: `hour12` sobrepõe `hourCycle` e, em es-AR, devolve
 * "7:00 p. m.". `formatInstant` remove um `hour12` que o chamador passe por engano.
 *
 * ⚠️ Teste de fuso na máquina de dev passa por coincidência (São Paulo = -03 = Buenos Aires):
 * rodar com `TZ=Asia/Tokyo` e `TZ=America/Los_Angeles` no comando.
 */

/** Fuso do operador (Argentina). IANA, não offset fixo: o IANA acompanha mudança de regra do país. */
export const OPERATION_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** Offset de `OPERATION_TIME_ZONE` (a Argentina não tem horário de verão) — só para INTERPRETAR input digitado. */
const OPERATION_UTC_OFFSET = '-03:00';

export type DateInput = string | number | Date | null | undefined;

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const CLOCK_TIME_RE = /^(\d{2}):(\d{2})/;
const DATETIME_LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

function toValidDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * INSTANTE → texto no fuso do operador, em 24h. `null` se `value` for nulo/vazio/inválido
 * (cada chamador decide o fallback: `'—'`, `''`, o ISO cru…).
 */
export function formatInstant(
  value: DateInput,
  options: Intl.DateTimeFormatOptions,
  locale: string = 'es-AR',
): string | null {
  const date = toValidDate(value);
  if (!date) return null;
  const { hour12: _ignored, ...rest } = options;
  return new Intl.DateTimeFormat(locale, { ...rest, hourCycle: 'h23', timeZone: OPERATION_TIME_ZONE }).format(date);
}

/**
 * SÓ-DATA → texto SEM conversão de fuso. Aceita `"YYYY-MM-DD"` ou `"YYYY-MM-DDT…"` (só os 10
 * primeiros caracteres contam). `null` se não for uma data de calendário.
 */
export function formatCalendarDate(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  locale: string = 'es-AR',
): string | null {
  if (!value) return null;
  const m = CALENDAR_DATE_RE.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(new Date(ms));
}

/**
 * `Date` construída com o relógio LOCAL (planilha sem fuso, ex. ClickUp via `parseDate`) → texto da
 * data de calendário que ela representa. Lê os getters locais — os mesmos que a construíram — e
 * delega a `formatCalendarDate`, então não há conversão de fuso.
 */
export function formatWallDate(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  locale: string = 'es-AR',
): string | null {
  if (Number.isNaN(date.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return formatCalendarDate(`${String(date.getFullYear()).padStart(4, '0')}-${p(date.getMonth() + 1)}-${p(date.getDate())}`, options, locale);
}

/**
 * SÓ-HORA → `HH:MM` por string (`"19:00:00"` → `"19:00"`). `null` para nulo/vazio; um texto que
 * não começa com `HH:MM` volta como veio (não inventa hora).
 */
export function formatClockTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = CLOCK_TIME_RE.exec(value);
  return m ? `${m[1]}:${m[2]}` : value;
}

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

/** Partes (ano, mês, dia, hora, minuto) de um INSTANTE no fuso do operador. `null` se inválido. */
export function getInstantParts(value: DateInput): WallParts | null {
  const date = toValidDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATION_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute') };
}

/** Dia civil de HOJE no fuso do operador, `YYYY-MM-DD` (e não o dia UTC de `toISOString()`). */
export function todayInOperationZone(now: Date = new Date()): string {
  const p = getInstantParts(now)!;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** INSTANTE → `yyyy-MM-ddTHH:mm` no fuso do operador: o que `<input type="datetime-local">` espera. */
export function toOperationDateTimeLocal(value: DateInput): string {
  const p = getInstantParts(value);
  if (!p) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * `yyyy-MM-ddTHH:mm` digitado (hora do OPERADOR, -03) → ISO UTC (`Date.toISOString`). `null` se o
 * texto não tiver esse formato ou não for uma data válida.
 */
export function parseOperationDateTimeLocal(value: string): string | null {
  const m = DATETIME_LOCAL_RE.exec(value);
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}:00${OPERATION_UTC_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
