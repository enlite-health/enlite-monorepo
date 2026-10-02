/**
 * Intervalo do diálogo de exportação (spec 032). Hasta é INCLUSIVO; o teto de 62 dias é o mesmo da
 * rota (`exportQuerySchema`, backend). Funções puras: o diálogo decide "Exportar" desabilitado a
 * partir daqui, e o backend segue sendo a palavra final (400).
 */
export const MAX_EXPORT_DAYS = 62;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Epoch (UTC) de uma data `YYYY-MM-DD` real; `null` se vazia, mal formatada, inexistente ou de ano parcial (< 2000). */
function toEpoch(iso: string): number | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000) return null; // `<input type=date>` emite `0002-09-07` enquanto o ano é digitado
  const epoch = Date.UTC(year, month - 1, day);
  const back = new Date(epoch);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? epoch : null;
}

/** Dias corridos entre Desde e Hasta, ambos inclusivos; `null` se alguma data é inválida ou Hasta < Desde. */
export function rangeDays(desde: string, hasta: string): number | null {
  const a = toEpoch(desde);
  const b = toEpoch(hasta);
  if (a === null || b === null || b < a) return null;
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

export function isValidRange(desde: string, hasta: string): boolean {
  const days = rangeDays(desde, hasta);
  return days !== null && days <= MAX_EXPORT_DAYS;
}
