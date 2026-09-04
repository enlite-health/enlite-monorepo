/**
 * scripts/lib/maskEmail.ts — mascara e-mail para log (B3).
 *
 * `mask` existia copiada em `espelhar-staff-stage.ts` e `iam-config-import.ts` (byte a
 * byte). Nunca logar e-mail completo em texto claro (regra dura de PII). Única fonte agora.
 */
export function maskEmail(email: string): string {
  return email.replace(/^(..).*@/, '$1…@');
}
