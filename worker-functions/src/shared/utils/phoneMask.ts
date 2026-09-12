/**
 * Mascara telefone pra log — dono único da máscara de telefone em log (substitui
 * o extinto `redactContact`; achado do gate 11/09, 608 ocorrências/7d em prd:
 * a versão por POSIÇÃO de caractere que `maskPhoneForLog` tinha antes desse fix
 * EXPUNHA MAIS que `redactContact` sempre que a entrada não chegava em E.164 —
 * ex.: `maskPhoneForLog('1151265663')` dava `1151**5663` (8 de 10 dígitos
 * visíveis), o extinto dava `***5663` (4 de 10). Sítio medido:
 * `ProcessTalentumPrescreening.ts` recebe `phoneNumber` CRU do webhook Talentum,
 * sem formato garantido (schema só exige string não-vazia).
 *
 * Por isso trabalha por DÍGITO, não por posição de caractere — a entrada pode vir
 * em QUALQUER formato (E.164 com/sem `+`, local, com espaço/traço), a saída é
 * sempre a mesma pro mesmo telefone lógico:
 *   - < 8 dígitos → "****" (dígitos insuficientes pra qualquer prefixo seguro)
 *   - >= 11 dígitos E não começa com "0" (tem código de país) → "+" + 3
 *     primeiros dígitos + 6 asteriscos + 4 últimos dígitos (mantém IDÊNTICO o
 *     formato E.164 de antes: "+5491155261243" → "+549******1243").
 *     O "não começa com 0" é obrigatório: pelo plano E.164 nenhum código de
 *     país começa em "0" (são sempre 1-3 dígitos, atribuídos a partir de 1..9)
 *     — quem começa com "0" é tronco nacional (ex.: local argentino
 *     "011 5126-5663", 11 dígitos), e sem esse filtro esse caso caía aqui e
 *     expunha tronco+área (achado do gate: "+011******5663").
 *   - 8-10 dígitos, OU >= 11 dígitos começando com "0" (local, sem código de
 *     país) → 6 asteriscos + 4 últimos dígitos — NUNCA o prefixo local, que
 *     sozinho já ajuda a identificar (DDD + começo do número, em vez de
 *     código de país)
 *
 * O número de asteriscos é FIXO (6) nos dois ramos — a versão anterior variava
 * o meio por `phone.length - 8`, o que vazava o TAMANHO do número original só
 * pelo comprimento da máscara; fixo em 6 esconde também esse metadado.
 *
 * Sem espaços — otimizado pra busca no Cloud Logging por filtro exato, e permite
 * usar como valor literal em filtros jsonPayload.phoneMasked="...".
 *
 * NUNCA usar para exibição ao usuário — use maskPhone.
 */
export function maskPhoneForLog(phone: string | null | undefined): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return '****';
  if (digits.length >= 11 && !digits.startsWith('0')) {
    return `+${digits.slice(0, 3)}******${digits.slice(-4)}`;
  }
  return `******${digits.slice(-4)}`;
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
