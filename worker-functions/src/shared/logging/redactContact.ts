import * as crypto from 'crypto';

const REDACTED_EMPTY = '(vazio)';
const REDACTED_UNRECOGNIZABLE = '***';

/**
 * Mascara telefone/e-mail para log — o valor original NUNCA aparece na saída.
 *
 * Achado do lex/gate (11/09): telefone e e-mail de worker/paciente iam crus pro
 * Cloud Logging em vários pontos (chamada de WhatsApp, convite de Calendar,
 * lookup de prescreening). A régua da casa é "nunca logar PII" — mas um log que
 * não distingue NENHUM contato também não serve pra debugar. Este helper é o
 * meio-termo: dá o suficiente pra reconhecer "é o mesmo contato de novo" sem
 * reconstituir o valor.
 *
 * - `phone`: só os 4 últimos dígitos ficam visíveis. O prefixo de país
 *   argentino ("54" ou "549" — formato canônico de `normalizePhoneAR`) pode
 *   ficar visível porque ele sozinho não identifica ninguém — o país inteiro
 *   compartilha o mesmo prefixo.
 * - `email`: nunca o local-part em claro. Sai um hash curto (sha256, 6 hex,
 *   ESTÁVEL — mesma entrada sempre gera a mesma saída, então dois logs do
 *   mesmo e-mail casam sem expor o valor) + o domínio (baixo risco: identifica
 *   o provedor, não a pessoa).
 * - vazio/nulo: marcador fixo, nunca uma string vazia (que se confundiria com
 *   "não tentei mascarar nada").
 */
export function redactContact(value: string | null | undefined, kind: 'phone' | 'email'): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return REDACTED_EMPTY;

  if (kind === 'phone') {
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return REDACTED_EMPTY;
    if (digits.length <= 4) return `${REDACTED_UNRECOGNIZABLE}${digits}`;

    const last4 = digits.slice(-4);
    const countryMatch = /^54(9)?/.exec(digits);
    const countryPrefix = countryMatch ? countryMatch[0] : '';
    return `${countryPrefix}${REDACTED_UNRECOGNIZABLE}${last4}`;
  }

  // kind === 'email'
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return REDACTED_UNRECOGNIZABLE;

  const localPart = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const hash = crypto.createHash('sha256').update(localPart).digest('hex').slice(0, 6);
  return `${hash}@${domain}`;
}
