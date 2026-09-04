/**
 * scripts/lib/cliArgs.ts — parse de argv comum aos scripts de linha de comando (B3).
 *
 * `argValue` existia copiada em `set-staff-country-claim.ts`, `iam-config-export.ts` e
 * `iam-config-import.ts` (byte a byte). Única fonte agora.
 */
export function argValue(flag: string, argv: string[] = process.argv): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
