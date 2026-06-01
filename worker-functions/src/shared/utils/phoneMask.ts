/**
 * Mascara phone E.164 pra log: mantém prefixo país (4) + últimos 4, oculta meio.
 * Sem espaços — otimizado pra busca no Cloud Logging por filtro exato.
 *
 * Ex: "+5491155261243" → "+549******1243"
 *
 * Diferente de maskPhone (pra UI): este não tem espaços nem traço, é mais curto
 * e permite usar como valor literal em filtros jsonPayload.phoneMasked="...".
 *
 * NUNCA usar para exibição ao usuário — use maskPhone.
 */
export function maskPhoneForLog(phone: string): string {
  if (!phone || phone.length < 8) return '****';
  const head = phone.slice(0, 4); // +549, +551, etc.
  const tail = phone.slice(-4);
  const middle = '*'.repeat(Math.max(phone.length - 8, 1));
  return `${head}${middle}${tail}`;
}

/**
 * Mascara um número de telefone mostrando apenas:
 *   - prefixo do país (ex: +54)
 *   - indicativo da operadora / área
 *   - 4 últimos dígitos
 *
 * Exemplos:
 *   "+5491155261243"  → "+54 9 11 ****-1243"
 *   "+5511998887766"  → "+55 11 ****-7766"
 *   "+5491155261243"  com 11 digitos → "+54 9 11 ****-1243"
 *
 * Regras:
 *   - Número menor que 7 dígitos → retorna "****" (sem info suficiente)
 *   - Argentina (+549XXXXXXXXXX 13 dígitos): mostra +54 9 <área> ****-<4 últimos>
 *   - Brasil (+55XXXXXXXXXXX 13 dígitos): mostra +55 <2 dígitos área> ****-<4 últimos>
 *   - Fallback genérico para outros países/formatos
 */
export function maskPhone(phone: string): string {
  if (!phone) return '****';

  // Remove tudo que não seja dígito ou '+'
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned) return '****';

  const hasPlus = cleaned.startsWith('+');
  const digits = cleaned.replace(/^\+/, '');

  if (digits.length < 7) return '****';

  const last4 = digits.slice(-4);
  const prefix = hasPlus ? '+' : '';

  // Argentina: +549XXXXXXXXXX (13 dígitos → +54 9 XX ****-XXXX)
  if (digits.startsWith('549') && digits.length === 13) {
    const area = digits.slice(3, 5); // 2 dígitos da área (ex: 11)
    return `${prefix}54 9 ${area} ****-${last4}`;
  }

  // Argentina interior: +549XXXXXXXXX (12 dígitos → +54 9 X ****-XXXX)
  if (digits.startsWith('549') && digits.length === 12) {
    const area = digits.slice(3, 4);
    return `${prefix}54 9 ${area} ****-${last4}`;
  }

  // Brasil: +55XXXXXXXXXXX (13 dígitos → +55 XX ****-XXXX)
  if (digits.startsWith('55') && digits.length === 13) {
    const area = digits.slice(2, 4);
    return `${prefix}55 ${area} ****-${last4}`;
  }

  // Fallback: mostra código do país (2–3 dígitos) + ****-últimos4
  const countryLen = digits.length >= 12 ? 2 : 1;
  const country = digits.slice(0, countryLen);
  return `${prefix}${country} ****-${last4}`;
}
