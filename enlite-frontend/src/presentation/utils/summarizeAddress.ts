/**
 * summarizeAddress / streetLineOf / addressLines
 *
 * Três leituras do MESMO endereço formatado (tipicamente
 * `patient_addresses.address_formatted`, vindo do Google Places), pela MESMA
 * fronteira rua↔resto — por isso moram no mesmo módulo e compartilham
 * `splitStreetAndRest`:
 *  - `summarizeAddress` — chamada STANDALONE (VacancyFormSection.tsx:356,
 *    campo "Location" da vaga): um resumo em nível de localidade (ex.:
 *    "Tigre, Provincia de Buenos Aires" ou "Consolação, São Paulo - SP").
 *    ⚠️ Comportamento observável NÃO é mais idêntico ao de antes do porte de
 *    `streetLineOf` para o formato BR real (rua, "número - bairro" no MESMO
 *    segmento, ex. "975 - Consolação"): antes o número vazava para o resumo
 *    ("975 - Consolação, São Paulo - SP"); agora sai ("Consolação, São Paulo
 *    - SP") — mudança AUTORIZADA pelo Gabriel (achado BLOCKER do gate
 *    `revisao-pr`, spec Localizaciones Fase 1). Os endereços AR (número
 *    sempre inline no 1º segmento, nunca "NNN - resto") são bit-a-bit
 *    idênticos a antes — provado em summarizeAddress.test.ts pelo describe
 *    "paridade com origin/main (endereços AR reais)".
 *  - `streetLineOf` — o que a rua É: nome + número (mesma origem acima).
 *  - `addressLines` — a combinação usada por LocalizacoesCard.tsx: linha 1 =
 *    `streetLineOf`, linha 2 = resumo de localidade SEM repetir o que a
 *    linha 1 já mostrou. Precisa existir separado de `summarizeAddress`
 *    porque, quando NENHUM padrão de rua é reconhecido (`streetParts` vazio
 *    — ex. "Tigre, Provincia de Buenos Aires, Argentina", sem rua nenhuma),
 *    `streetLineOf` cai no 1º segmento como melhor esforço ("Tigre") — e
 *    `summarizeAddress`, chamada standalone sobre o MESMO texto, começaria
 *    a resumir DAQUELE MESMO 1º segmento em diante, repetindo-o na linha 2
 *    ("Tigre, Provincia de Buenos Aires"). Achado MINOR do gate
 *    `revisao-pr`, 2ª rodada. `addressLines` corta esse 1º segmento (o que
 *    virou linha 1) antes de resumir, e NUNCA deixa o país sozinho virar
 *    linha 2 (`summarizeAddress` mantém o país sozinho só no caso
 *    degenerado de entrada SEM rua nenhuma reconhecida E sem mais nada —
 *    ver `stripCountryAndPostal`; para linha 2 isso não faz sentido: `null`
 *    é a resposta certa quando não sobra localidade real).
 *
 * Heurísticas da fronteira (`splitStreetAndRest`):
 *  - segmento único "Av. Italia 736" (AR): termina em " <número>".
 *  - dois segmentos "Rua Augusta", "975" (BR raro — número como segmento à
 *    parte).
 *  - dois segmentos "Rua Augusta", "975 - Consolação" (BR real — o formato
 *    que o Google de fato devolve: número e bairro no MESMO segmento,
 *    separados por " - ").
 *  - drop do país final (Argentina/Brasil/etc.) e dos CEPs (AR prefixo,
 *    BR `NNNNN-NNN`).
 *
 * Pure functions — sem DOM, sem I/O. `''`/`null` quando a entrada é vazia.
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

/**
 * Tira o país final e os CEPs de `rest`. `keepDegenerateCountry` preserva o
 * comportamento HISTÓRICO de `summarizeAddress` quando o país é o ÚNICO
 * segmento restante (`summarizeAddress('Argentina')` → `'Argentina'`, não
 * `''` — "não invente ausência apagando o único dado que a entrada trazia").
 * `addressLines` passa `false`: ali um país sozinho na linha 2 não é essa
 * garantia nenhuma, é ruído — `null` (sem linha 2) é a resposta certa.
 */
function stripCountryAndPostal(rest: string[], keepDegenerateCountry: boolean): string {
  let result = rest;

  const lastIsCountry =
    result.length > 0 && COUNTRIES.has(result[result.length - 1].toLowerCase());
  const shouldStripCountry = keepDegenerateCountry
    ? result.length > 1 && lastIsCountry
    : lastIsCountry;
  if (shouldStripCountry) {
    result = result.slice(0, -1);
  }

  // Strip postal codes (AR prefix on the locality, BR CEP anywhere).
  result = result
    .map((s) => s.replace(AR_POSTAL_PREFIX_RE, ''))
    .map((s) => s.replace(BR_CEP_RE, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return result.join(', ');
}

export function summarizeAddress(formatted: string | null | undefined): string {
  const parts = splitParts(formatted);
  if (parts.length === 0) return '';

  const result = splitStreetAndRest(parts).rest;
  return stripCountryAndPostal(result, /* keepDegenerateCountry */ true);
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

/**
 * A combinação que `LocalizacoesCard.tsx` usa: linha 1 = `streetLineOf`,
 * linha 2 = resumo de localidade que NUNCA repete o que a linha 1 já
 * mostrou, e NUNCA vira só o país sozinho (`null` nesses dois casos). Ver o
 * comentário do módulo para o porquê de não bastar `streetLineOf` +
 * `summarizeAddress` chamadas em paralelo sobre o mesmo texto.
 */
export function addressLines(
  formatted: string | null | undefined,
): { line1: string; line2: string | null } {
  const parts = splitParts(formatted);
  if (parts.length === 0) return { line1: '', line2: null };

  // A linha 1 vem de `streetLineOf` — não reescreve aqui o "cai no 1º segmento quando
  // nenhuma rua é reconhecida": é a MESMA regra, reusada (achado MINOR do gate
  // `revisao-pr`, 3ª rodada — as duas funções tinham a mesma queda-para-parts[0] escrita
  // duas vezes). `splitStreetAndRest` roda de novo só para decidir o que sobra PARA a
  // linha 2 (`rest`, quando a rua foi reconhecida, ou `parts.slice(1)`, quando não foi —
  // ver o comentário do módulo para o porquê da diferença).
  const { streetParts, rest } = splitStreetAndRest(parts);
  const restForLine2 = streetParts.length > 0 ? rest : parts.slice(1);
  const line1 = streetLineOf(formatted);
  const line2 = stripCountryAndPostal(restForLine2, /* keepDegenerateCountry */ false) || null;
  return { line1, line2 };
}
