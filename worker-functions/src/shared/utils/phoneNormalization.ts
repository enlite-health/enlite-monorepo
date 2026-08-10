/**
 * Phone normalization utilities for Argentinian phone numbers.
 * Extracted from the deprecated import-utils.ts during upload feature removal (2026-04-23).
 * Used by Talentum sync/prescreening flows and admin worker lookup.
 */

/**
 * Normaliza telefones argentinos para o formato canônico 549XXXXXXXXXX.
 *
 * Regras (baseadas nos dados reais das planilhas):
 *   10 dígitos  → falta prefixo país+móvel → prepend '549'
 *                 ex: 1151265663 → 5491151265663
 *   11 dígitos começando com '54' → falta o '9' do móvel → insert '9' depois de '54'
 *                 ex: 54111265663 → 549111265663
 *   12 dígitos começando com '54' mas não '549' → mesmo caso
 *                 ex: 541151265663 → 5491151265663
 *   13 dígitos começando com '549' → já correto
 *   Outros (8, 9, 14+) → strip only, retorna como está (formato incomum/erro de dado)
 */
export function normalizePhoneAR(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 10) {
    return '549' + digits;
  }
  if (digits.length === 11 && digits.startsWith('54')) {
    // ex: 54111265663 → 549 + 111265663
    return '549' + digits.slice(2);
  }
  if (digits.length === 12 && digits.startsWith('54') && !digits.startsWith('549')) {
    // ex: 541151265663 → 549 + 1151265663
    return '549' + digits.slice(2);
  }
  if (digits.length === 13 && digits.startsWith('549')) {
    return digits; // já correto
  }

  // Comprimentos incomuns (8, 9, 14+): retorna dígitos sem formatação
  return digits;
}

/**
 * Inverso de normalizePhoneAR: devolve o número NACIONAL, sem o código de país.
 *
 * Existe porque sistemas de terceiro guardam o país num campo próprio (select box)
 * e esperam só o número nacional no campo de telefone. Mandar o E.164 inteiro faz
 * o país virar parte do número — foi o que aconteceu com o espelho do Ana Care:
 * 85 de 777 enfermeiras ficaram com '549...' no campo `telefono`, e todas as 85
 * eram registros criados por nós (medido em 10/08/2026; 87% da base deles é
 * nacional de 10 dígitos).
 *
 * Regras (espelham normalizePhoneAR, na direção contrária):
 *   13 dígitos começando com '549' → tira '549'  → 10 dígitos (ex: 5491151265663 → 1151265663)
 *   12 dígitos começando com '549' → tira '549'  →  9 dígitos (interior)
 *   12 dígitos começando com '54' (não '549')    → tira '54' → 10 dígitos
 *   11 dígitos começando com '54' (não '549')    → tira '54' →  9 dígitos
 *   Qualquer outro caso                          → só dígitos, inalterado
 *
 * Conservador de propósito: só remove quando o que sobra tem comprimento nacional
 * plausível (9 ou 10). Número curto/estrangeiro/malformado passa intacto — melhor
 * espelhar como está do que mutilar um dado que não entendemos.
 */
export function toNationalAR(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('549') && (digits.length === 13 || digits.length === 12)) {
    return digits.slice(3);
  }
  if (digits.startsWith('54') && !digits.startsWith('549')
      && (digits.length === 12 || digits.length === 11)) {
    return digits.slice(2);
  }

  return digits;
}

/**
 * Gera todas as variantes de formato de um número de telefone
 * que podem estar armazenadas no banco de dados.
 *
 * O banco pode ter números em formatos históricos variados:
 *   - 549XXXXXXXXXX (13 dígitos, canônico Buenos Aires)
 *   - 549XXXXXXXXX  (12 dígitos, canônico interior)
 *   - XXXXXXXXXX    (10 dígitos, local Buenos Aires sem prefixo)
 *   - 54XXXXXXXXXX  (12 dígitos, sem o 9 do móvel)
 *   - Os dígitos exatos como foram digitados (fallback)
 *
 * Retorna array de candidatos únicos para uso em WHERE phone = ANY($1).
 */
export function generatePhoneCandidates(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return [];

  const candidates = new Set<string>();
  candidates.add(digits); // inclui sempre os dígitos exatos (fallback)

  const canonical = normalizePhoneAR(digits);
  if (canonical) candidates.add(canonical);

  // Para canonical de 13 dígitos (formato Buenos Aires: 549XXXXXXXXXX)
  if (canonical.length === 13 && canonical.startsWith('549')) {
    const local = canonical.slice(3);       // 10 dígitos: XXXXXXXXXX
    candidates.add(local);
    candidates.add('54' + local);           // 12 dígitos: 54XXXXXXXXXX (sem o 9)
  }

  // Para canonical de 12 dígitos (formato interior: 549XXXXXXXXX)
  if (canonical.length === 12 && canonical.startsWith('549')) {
    const local = canonical.slice(3);       // 9 dígitos
    candidates.add(local);
    candidates.add('54' + local);           // 11 dígitos: 54XXXXXXXXX
  }

  // Filtra candidatos muito curtos (ruído)
  const digitVariants = Array.from(candidates).filter(c => c.length >= 7);

  // Para cada variante dígito-only, também emite versão com prefixo '+'.
  // Os dados podem estar salvos no banco em qualquer um dos dois formatos
  // (ex.: contatos vindos de WhatsApp/Twilio costumam ter '+', mas Talentum
  // sync salva sem). O ANY($1) então cobre os dois universos.
  return digitVariants.concat(digitVariants.map(c => '+' + c));
}
