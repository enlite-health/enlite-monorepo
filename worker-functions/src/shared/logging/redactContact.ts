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
 *   compartilha o mesmo prefixo. Aceito pelo lex sem ressalva (C4, 11/09).
 * - `email`: SEMPRE `***@dominio` — nunca o local-part, nem um hash dele.
 *   Parecer do lex (C4, 11/09): a 1ª versão usava sha256(local-part).slice(0,6),
 *   que é REVERSÍVEL por dicionário (local-parts de e-mail corporativo/pessoal
 *   têm entropia baixa — não é senha, é nome.sobrenome) sem precisar quebrar o
 *   hash, só testar candidatos. Corrigir direito pediria HMAC com CHAVE em
 *   Secret Manager (padrão que a casa já usa pra blind index de telefone/nome,
 *   ver `BlindIndexService`) — infraestrutura nova, fora do escopo deste
 *   conserto. A queda seca aceita pelo lex: `***@dominio`, sem tentar
 *   distinguir e-mails diferentes do mesmo domínio nos logs. O domínio sai
 *   porque identifica o provedor, não a pessoa.
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

  const domain = trimmed.slice(at + 1);
  return `${REDACTED_UNRECOGNIZABLE}@${domain}`;
}
