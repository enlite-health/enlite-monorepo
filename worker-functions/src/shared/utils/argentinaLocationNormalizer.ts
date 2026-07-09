/**
 * argentinaLocationNormalizer
 *
 * SSOT de normalização de campos de localização argentina vindos de fontes
 * externas sujas (ClickUp address_components, formatted_address parseado por
 * vírgula, texto livre digitado por operação). Usado na borda do import
 * (locationHelpers.ts / ClickUpPatientMapper.ts) e no script de backfill de
 * `patient_addresses` — mesma normalização em write-path e backfill evita
 * divergência (mesma lição de normalizeSexValue.ts).
 *
 * Saída de `normalizeProvince` é um LABEL DE EXIBIÇÃO PÚBLICA em espanhol
 * (não é enum interno UPPERCASE) — requisito de negócio: os filtros
 * Provincia/Localidad do site público (jobs.enlite.health) exibem esses
 * valores diretamente.
 */

/**
 * 'null'/'NULL'/''/whitespace → null. Trima e preserva o valor original
 * (com acentos/capitalização) quando válido.
 */
export function cleanNullLiteral(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/**
 * Padrão de CEP argentino (CPA — Código Postal Argentino): 1 letra opcional +
 * 4 dígitos + até 3 letras opcionais. Usado tanto para reconhecer um PREFIXO
 * ("B1602 Florida") quanto um valor que é SÓ o CEP, sem nome de localidade
 * nenhum (ex: "C1126ABC" — bug real de prod: o Google Geocoding às vezes
 * retorna o próprio CEP como `long_name` de um componente de cidade/bairro
 * quando não há uma localidade nomeada nessa granularidade).
 */
const ARGENTINE_POSTAL_CODE_PATTERN = '[A-Za-z]?\\d{4}[A-Za-z]{0,3}';

/**
 * true quando o valor inteiro (após trim) é SÓ um CEP argentino, sem
 * nenhum texto de localidade antes ou depois — ex: "C1126ABC", "B1602",
 * "1602". Retorna false para "B1602 Florida" (tem localidade após o CEP)
 * ou qualquer string que não seja puramente o padrão de CEP.
 */
export function isPureArgentinePostalCode(value: string | null | undefined): boolean {
  const cleaned = cleanNullLiteral(value);
  if (!cleaned) return false;
  return new RegExp(`^${ARGENTINE_POSTAL_CODE_PATTERN}$`).test(cleaned);
}

/**
 * Remove prefixo de CEP argentino de uma localidade, ex: "B1602 Florida" →
 * "Florida", "V9410 Ushuaia" → "Ushuaia". Quando o valor INTEIRO é só o CEP
 * sem nenhum nome de localidade (ex: "C1126ABC") → null, já que não há
 * localidade nenhuma pra reportar (ver `isPureArgentinePostalCode`; bug real
 * de prod — Google retornou o CEP puro como valor do componente de
 * cidade/bairro). String que vira vazia após o strip → null.
 */
export function stripPostalCodePrefix(value: string | null | undefined): string | null {
  const cleaned = cleanNullLiteral(value);
  if (!cleaned) return null;
  if (isPureArgentinePostalCode(cleaned)) return null;
  const stripped = cleaned.replace(new RegExp(`^${ARGENTINE_POSTAL_CODE_PATTERN}\\s+`), '').trim();
  return stripped || null;
}

/**
 * Remove acentos, uppercase, trim e o sufixo inglês " Province" — chave de
 * lookup interna para o mapa de províncias canônicas.
 */
function normalizeKey(value: string): string {
  const withoutAccents = value
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');
  return withoutAccents
    .replace(/\s+PROVINCE$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mapa canônico de províncias argentinas (24 jurisdições: CABA + 23
 * províncias). Chaves são a forma normalizada (sem acento, uppercase, sem
 * sufixo " Province"); valores são o label de exibição pública correto.
 */
const PROVINCE_CANONICAL: Readonly<Record<string, string>> = {
  // CABA
  'CABA': 'CABA',
  'CIUDAD AUTONOMA DE BUENOS AIRES': 'CABA',
  'CAPITAL FEDERAL': 'CABA',

  // Provincia de Buenos Aires
  'BUENOS AIRES': 'Provincia de Buenos Aires',
  'PROVINCIA DE BUENOS AIRES': 'Provincia de Buenos Aires',
  'PBA': 'Provincia de Buenos Aires',
  'GBA': 'Provincia de Buenos Aires',

  // Demais 22 províncias
  'CATAMARCA': 'Catamarca',
  'CHACO': 'Chaco',
  'CHUBUT': 'Chubut',
  'CORDOBA': 'Córdoba',
  'CORRIENTES': 'Corrientes',
  'ENTRE RIOS': 'Entre Ríos',
  'FORMOSA': 'Formosa',
  'JUJUY': 'Jujuy',
  'LA PAMPA': 'La Pampa',
  'LA RIOJA': 'La Rioja',
  'MENDOZA': 'Mendoza',
  'MISIONES': 'Misiones',
  'NEUQUEN': 'Neuquén',
  'RIO NEGRO': 'Río Negro',
  'SALTA': 'Salta',
  'SAN JUAN': 'San Juan',
  'SAN LUIS': 'San Luis',
  'SANTA CRUZ': 'Santa Cruz',
  'SANTA FE': 'Santa Fe',
  'SANTIAGO DEL ESTERO': 'Santiago del Estero',
  'TIERRA DEL FUEGO': 'Tierra del Fuego',
  'TUCUMAN': 'Tucumán',
};

/**
 * Normaliza um valor de província argentina para o label canônico de
 * exibição pública. Aceita variantes case/acento-insensitive e o sufixo
 * inglês " Province". Retorna null quando o input não é uma província
 * reconhecida (cidade, prefixo postal, lixo) — NUNCA inventa um valor.
 *
 * Decisão sobre CEP puro (ex: "C1126ABC"): NÃO precisa de guard explícito
 * aqui — nenhuma chave de `PROVINCE_CANONICAL` é um CEP, então o lookup já
 * retorna null naturalmente pra esse input. O guard explícito (via
 * `isPureArgentinePostalCode`) vive só em `stripPostalCodePrefix`, onde SEM
 * ele o valor passaria intacto (nenhum prefixo a remover quando a string
 * INTEIRA é o CEP).
 */
export function normalizeProvince(raw: string | null | undefined): string | null {
  const cleaned = cleanNullLiteral(raw);
  if (!cleaned) return null;
  const key = normalizeKey(cleaned);
  return PROVINCE_CANONICAL[key] ?? null;
}
