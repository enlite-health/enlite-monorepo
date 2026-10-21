/**
 * sqlComVars — SQL PARAMETRIZADO para os e2e (spec 058 B, regra 10). O valor entra por `psql -v nome=valor` e é usado no SQL como `:'nome'`
 * (psql o escapa como literal); nunca é concatenado na string do SQL e não passa por shell (`execFileSync`). O SQL vai por stdin
 * (`:'nome'` NÃO é expandido em `-c`). Devolve a saída em texto (`-tA`), sem espaços nas pontas. Mesmo container/banco de `runSQL`.
 */
import { execFileSync } from 'child_process';

export function sqlComVars(sql: string, vars: Record<string, string> = {}): string {
  const args = ['exec', '-i', process.env.E2E_PG_CONTAINER || 'enlite-postgres', 'psql', '-U', 'enlite_admin', '-d', 'enlite_e2e', '-tA', '-v', 'ON_ERROR_STOP=1',
    ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])];
  return execFileSync('docker', args, { input: sql, encoding: 'utf-8' }).trim();
}
