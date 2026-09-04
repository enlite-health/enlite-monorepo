/**
 * scripts/lib/maskEmail.ts — mascara e-mail para log (B3).
 *
 * `mask` existia copiada em `espelhar-staff-stage.ts` e `iam-config-import.ts` (byte a
 * byte). Nunca logar e-mail completo em texto claro (regra dura de PII). Única fonte agora.
 *
 * (M6) local-part de 1 char (ou vazio) fica TOTALMENTE oculto — `…@domínio`;
 * 2+ chars mantêm os 2 primeiros + `…@domínio`. A regex antiga (`/^(..).*@/`)
 * falhava CALADA nesse caso: o `.` do grupo `(..)` também casa `@`, então em
 * `a@enlite.health` o grupo já consumia o único `@` da string, o `.*@` seguinte
 * não achava um segundo `@` para casar, o regex inteiro falhava, e
 * `.replace` sem match devolve a string ORIGINAL — o e-mail saía cru no log.
 *
 * Não reusa `maskEmail` de `src/modules/account-link/AccountLinkService.ts:298`:
 * contrato diferente (`ga•••@domínio`, null-safe, mantém até 4 chars) e este é
 * um script CLI — não importa serviço de módulo de aplicação (Clean
 * Architecture do app não se estende a `scripts/`).
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at === -1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return local.length <= 1 ? `…@${domain}` : `${local.slice(0, 2)}…@${domain}`;
}
