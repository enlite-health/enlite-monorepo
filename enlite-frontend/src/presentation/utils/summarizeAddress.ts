/**
 * summarizeAddress / streetLineOf
 *
 * Duas leituras do MESMO endereço formatado (tipicamente
 * `patient_addresses.address_formatted`, vindo do Google Places), pela MESMA
 * fronteira rua↔resto — por isso moram no mesmo módulo e compartilham
 * `splitStreetAndRest`:
 *  - `summarizeAddress` — o que sobra DEPOIS da rua: um resumo em nível de
 *    localidade (ex.: "Tigre, Provincia de Buenos Aires" ou "Consolação, São
 *    Paulo - SP"). Já existia; comportamento OBSERVÁVEL inalterado para os
 *    chamadores atuais (VacancyFormSection) — ver summarizeAddress.test.ts.
 *  - `streetLineOf` — o que a rua É: nome + número (spec Localizaciones Fase
 *    1, achado do gate `revisao-pr`: a Dirección da lista precisava da rua
 *    completa, e uma cópia local dessa fronteira em LocalizacoesCard.tsx
 *    divergia desta — BLOCKER, ver `derivePatientZone.ts`-style de porte
 *    fiel, mas para a fronteira rua/resto).
 *
 * Heurísticas da fronteira (`splitStreetAndRest`):
 *  - segmento único "Av. Italia 736" (AR): termina em " <número>".
 *  - dois segmentos "Rua Augusta", "975" (BR raro — número como segmento à
 *    parte).
 *  - dois segmentos "Rua Augusta", "975 - Consolação" (BR real — o formato
 *    que o Google de fato devolve: número e bairro no MESMO segmento,
 *    separados por " - "). Sem este terceiro caso, `summarizeAddress`
 *    incluía "975 -" no resumo (bug real, achado do gate) e `streetLineOf`
 *    perdia o número inteiro.
 *  - drop do país final (Argentina/Brasil/etc.) e dos CEPs (AR prefixo,
 *    BR `NNNNN-NNN`) — só em `summarizeAddress`.
 *
 * Pure functions — sem DOM, sem I/O. `''` quando a entrada é vazia.
 */

const STREET_PREFIX_RE =
  /^(?:rua|r\.|av\.?|avenida|calle|cl\.|plaza|pl\.|diagonal|camino|pje\.|pasaje|ruta|estrada|travessa|tv\.|alameda|al\.|boulevard|bd\.)(?=\s|$)/i;

const COUNTRIES = new Set([
  'argentina',
  'brasil',
  'brazil',
  'uruguay',
  'chile',
  'paraguay',
  'bolivia',
  'peru',
]);

const AR_POSTAL_PREFIX_RE = /^[A-Z]\d{4}[A-Z]*\s+/;
const BR_CEP_RE = /\b\d{5}-?\d{3}\b/g;
/** "975 - Consolação" → número + resto (o formato BR real, número e bairro no mesmo segmento). */
const BR_NUMBER_AND_REST_RE = /^(\d+(?:-\d+)?)\s*-\s*(.+)$/;

interface StreetSplit {
  /** Segmentos da RUA (nome, e número quando reconhecido) — nunca vazio junto com `rest` vazio. */
  streetParts: string[];
  /** O que sobra para `summarizeAddress` processar (país/CEP ainda não removidos). */
  rest: string[];
}

/**
 * A fronteira única entre "isto é a rua" e "isto é o resto" — usada pelas
 * duas funções públicas deste módulo. Ver o comentário do módulo para os 3
 * casos de segmento reconhecidos.
 */
function splitStreetAndRest(parts: string[]): StreetSplit {
  // `parts` nunca chega vazio: as DUAS chamadoras (`summarizeAddress`, `streetLineOf`) já
  // retornam cedo quando `splitParts` devolve `[]` — um guard aqui seria ramo morto (nenhum
  // teste o alcança, porque nenhum CALLER o alcança).
  const startsWithStreet =
    STREET_PREFIX_RE.test(parts[0]) || /\s\d+\s*$/.test(parts[0]);
  if (!startsWithStreet) return { streetParts: [], rest: parts };

  const streetParts = [parts[0]];
  let i = 1;
  if (i < parts.length) {
    if (/^\d+(?:-\d+)?$/.test(parts[i])) {
      // Caso B — número como segmento à parte ("Rua Augusta", "975").
      streetParts.push(parts[i]);
      i += 1;
    } else {
      const combined = BR_NUMBER_AND_REST_RE.exec(parts[i]);
      if (combined) {
        // Caso C — número + resto no MESMO segmento ("975 - Consolação"). `combined[2]` nunca
        // sobra em branco: o `\s*` antes do grupo já engoliu o espaço logo após o "-", e
        // `parts[i]` chega aqui SEM espaço sobrando no fim (todo segmento já passou por
        // `.trim()` em `splitParts`) — por isso não há `.trim()`/ternário aqui: seria ramo
        // morto, sem entrada real que o alcance.
        streetParts.push(combined[1]);
        return { streetParts, rest: [combined[2], ...parts.slice(i + 1)] };
      }
    }
  }
  return { streetParts, rest: parts.slice(i) };
}

function splitParts(formatted: string | null | undefined): string[] {
  const input = (formatted ?? '').trim();
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function summarizeAddress(formatted: string | null | undefined): string {
  const parts = splitParts(formatted);
  if (parts.length === 0) return '';

  let result = splitStreetAndRest(parts).rest;

  // Drop trailing country.
  if (
    result.length > 1 &&
    COUNTRIES.has(result[result.length - 1].toLowerCase())
  ) {
    result = result.slice(0, -1);
  }

  // Strip postal codes (AR prefix on the locality, BR CEP anywhere).
  result = result
    .map((s) => s.replace(AR_POSTAL_PREFIX_RE, ''))
    .map((s) => s.replace(BR_CEP_RE, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return result.join(', ');
}

/**
 * Rua + número, nos dois formatos (AR "Av. Corrientes 1234" já vem inteiro
 * no 1º segmento; BR "R. Augusta, 975" ou "R. Augusta, 975 - Consolação" tem
 * o número no 2º). `''` quando a entrada é vazia; quando nenhum padrão de
 * rua é reconhecido, devolve o 1º segmento como melhor esforço (nunca `''`
 * com entrada não-vazia).
 */
export function streetLineOf(formatted: string | null | undefined): string {
  const parts = splitParts(formatted);
  if (parts.length === 0) return '';

  const { streetParts } = splitStreetAndRest(parts);
  return (streetParts.length > 0 ? streetParts : [parts[0]]).join(', ');
}
