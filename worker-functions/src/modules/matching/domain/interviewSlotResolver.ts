/**
 * interviewSlotResolver — partes locais de um instante num fuso.
 *
 * (Spec 068: a oferta de slots da vaga saiu junto com as colunas
 * `meet_*` da vaga. Ficam só `localParts` e `DEFAULT_TIMEZONE`, usados por `operationDate.ts`
 * e `dateFormatters.ts`.)
 *
 * Fuso: tudo calculado no `timezone` pedido, nunca em UTC — "21h de Buenos Aires é meia-noite
 * em UTC". Sem biblioteca de fuso: `Intl.DateTimeFormat` resolve o offset por instante, o que
 * cobre o horário de verão de São Paulo/Buenos Aires.
 */

export const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

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
