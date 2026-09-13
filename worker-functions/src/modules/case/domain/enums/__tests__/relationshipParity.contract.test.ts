import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RELATIONSHIPS } from '../Relationship';

/**
 * TESTE DE CONTRATO — relação (`patient_responsibles.relationship`) atravessa TRÊS costuras:
 * o CHECK vivo no banco (migration 421, spec 018 PR-2, SUP-16), `Relationship.ts` (back) e
 * `RELATIONSHIP_CODES` de `enlite-frontend/src/domain/entities/patientEnums.ts:40` (front).
 *
 * Molde: workerProgressValidation.contract.test.ts (mesmo incidente — lista fechada copiada em
 * mais de um lugar diverge em silêncio). Lê o CHECK direto da migration mais recente que o
 * define — a MESMA lista que o Postgres aplica — e compara com as duas cópias em TypeScript.
 *
 * Se este teste falhar, NÃO edite a lista esperada: ajuste `Relationship.ts` e/ou
 * `RELATIONSHIP_CODES` (front) para bater com o CHECK. A verdade é a migration.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../../../migrations');
const FRONTEND_PATIENT_ENUMS = join(
  __dirname,
  '../../../../../../../enlite-frontend/src/domain/entities/patientEnums.ts',
);
const CONSTRAINT_NAME = 'patient_responsibles_relationship_check';

/** Acha a migration mais recente (maior prefixo numérico) que (re)define o CHECK — é a que está viva no banco. */
function latestMigrationDefiningCheck(constraintName: string): { file: string; sql: string } {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ f, n: Number.parseInt(f.split('_')[0], 10) }))
    .filter(({ n }) => Number.isFinite(n))
    .sort((a, b) => b.n - a.n);

  for (const { f } of candidates) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    if (new RegExp(`ADD\\s+CONSTRAINT\\s+${constraintName}\\b`, 'i').test(sql)) {
      return { file: f, sql };
    }
  }
  throw new Error(`Nenhuma migration define ${constraintName} — o instrumento está cego, não aprovado.`);
}

/** Extrai os códigos do CHECK (... relationship IN ('A','B',...)). */
function codesFromCheckSql(sql: string, constraintName: string): string[] {
  const anchor = sql.indexOf(`ADD CONSTRAINT ${constraintName}`);
  if (anchor === -1) throw new Error(`CONSTRAINT ${constraintName} não encontrada no SQL extraído`);
  const tail = sql.slice(anchor);
  const inMatch = tail.match(/relationship\s+IN\s*\(([^)]*)\)/is);
  if (!inMatch) throw new Error('Não achei a lista IN (...) do CHECK de relationship');
  return [...inMatch[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
}

/** Extrai `RELATIONSHIP_CODES` do arquivo do frontend (leitura crua — sem importar através do pacote). */
function relationshipCodesFromFrontend(): string[] {
  const src = readFileSync(FRONTEND_PATIENT_ENUMS, 'utf8');
  const match = src.match(/RELATIONSHIP_CODES\s*=\s*\[([^\]]*)\]/s);
  if (!match) throw new Error('Não achei RELATIONSHIP_CODES em patientEnums.ts — o instrumento está cego.');
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
}

describe('relationshipParity.contract — CHECK do banco × Relationship.ts × patientEnums.ts:RELATIONSHIP_CODES', () => {
  it('os 3 vocabulários batem, byte a byte (spec 018 PR-2, SUP-16, migration 421)', () => {
    const { file, sql } = latestMigrationDefiningCheck(CONSTRAINT_NAME);
    const doBanco = codesFromCheckSql(sql, CONSTRAINT_NAME);
    const doBack = [...RELATIONSHIPS].sort();
    const doFront = relationshipCodesFromFrontend();

    expect(doBack).toEqual(doBanco);
    expect(doFront).toEqual(doBanco);
    expect(doBanco.length).toBeGreaterThanOrEqual(15); // 9 originais (139) + 6 novos (421, SUP-16)
    expect(file.startsWith('421_')).toBe(true); // documenta qual migration está viva hoje
  });

  it('sabotagem: tirar COUSIN da lista do back faria o teste acusar (prova de que o instrumento morde)', () => {
    const semCousin = RELATIONSHIPS.filter((r) => r !== 'COUSIN');
    const { sql } = latestMigrationDefiningCheck(CONSTRAINT_NAME);
    const doBanco = codesFromCheckSql(sql, CONSTRAINT_NAME);
    expect([...semCousin].sort()).not.toEqual(doBanco);
  });
});
