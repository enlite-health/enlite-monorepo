/**
 * Conta de E2E: o e-mail do token termina em `@enlite.test` (comparado em minúsculas).
 * Fonte única: o init (nasce `is_test`) e a guarda de OTP (não envia) leem daqui.
 */
export function isEnliteTestEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase().endsWith('@enlite.test');
}
