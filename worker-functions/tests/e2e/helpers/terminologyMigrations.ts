/**
 * terminologyMigrations — as migrations que constroem o schema `terminology`, DERIVADAS do disco.
 *
 * 🔧 419 (08/09/2026): `icd11-unavailable-real-catalog` recria o schema (DROP + migrations) e tinha uma
 * lista FIXA (`['323', '328']`) que ficou para trás duas vezes — sem a 324 (o default privilege do
 * conector voltava) e sem a 419 (os grants de `app_runtime`/`app_system` sumiam, e os e2e que rodavam
 * DEPOIS reprovavam só no CI). Regra que o próprio arquivo escreveu: "quem recria o schema aplica a
 * lista INTEIRA". A lista agora é derivada: toda migration com uma LINHA de DDL/DCL que nomeia o
 * schema (também dentro de `EXECUTE format('...')`, como na 324) — string de COMMENT/prosa que o cita
 * (325/326) não conta. Migration futura do schema entra sozinha; `terminology-runtime-grants` trava
 * que 324 e 419 estão dentro.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export const MIGRATIONS_DIR = join(__dirname, '../../../migrations');
const TOCA_O_SCHEMA = /^\s*'?(CREATE|ALTER|GRANT|REVOKE|DROP|COMMENT ON)\b.*\bterminology\b/m;

export const MIGRATION_FILES_TERMINOLOGY: readonly string[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f) && TOCA_O_SCHEMA.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')))
  .sort();

export const MIGRATIONS_TERMINOLOGY_SQL: readonly string[] = MIGRATION_FILES_TERMINOLOGY.map((f) =>
  readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'),
);
