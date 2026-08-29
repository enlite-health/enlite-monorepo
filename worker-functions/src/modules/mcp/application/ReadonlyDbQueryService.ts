import type { Pool } from 'pg';

export interface ReadonlyQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** true quando o resultado foi cortado no maxRows. */
  truncated: boolean;
}

export const DEFAULT_MAX_ROWS = 100;
export const HARD_MAX_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Executa SQL ad-hoc de LEITURA pro conector Claude (db.query.readonly).
 * Defesa em profundidade — nesta ordem:
 *   1. App: só SELECT/WITH, single statement, LIMIT envolvente, timeout.
 *   2. Transação: BEGIN READ ONLY.
 *   3. Banco: role dedicada (enlite_mcp_ro) sem privilégio de escrita.
 * PII encriptada (colunas *_encrypted) sai como ciphertext opaco — a
 * decriptação KMS só existe nas capabilities específicas.
 */
export class ReadonlyDbQueryService {
  constructor(private readonly pool: Pool) {}

  async run(sql: string, maxRows: number = DEFAULT_MAX_ROWS): Promise<ReadonlyQueryResult> {
    const cleaned = validateAndNormalize(sql);
    const limit = Math.min(Math.max(1, maxRows), HARD_MAX_ROWS);
    // +1 pra detectar truncamento sem count extra
    const wrapped = `SELECT * FROM (${cleaned}) AS mcp_q LIMIT ${limit + 1}`;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const result = await client.query(wrapped);
      await client.query('COMMIT');

      const truncated = result.rows.length > limit;
      const rows = truncated ? result.rows.slice(0, limit) : result.rows;
      return { rows, rowCount: rows.length, truncated };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Colunas de texto clínico restrito (patients): proibidas em SQL ad-hoc. */
export const RESTRICTED_CLINICAL_COLUMNS = /emergency_instructions/i;

function validateAndNormalize(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    throw new Error('Empty SQL');
  }
  if (trimmed.includes(';')) {
    throw new Error('Only a single statement is allowed');
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Only SELECT/WITH queries are allowed');
  }
  // Texto clínico restrito NUNCA sai por SQL ad-hoc para um LLM (D211.2, lex 29/08 C2): a coluna
  // é redigida por permissão na API; esta capability não passa por aquele ponto, então nega aqui.
  if (RESTRICTED_CLINICAL_COLUMNS.test(trimmed)) {
    throw new Error('Query touches a restricted clinical column (emergency_instructions)');
  }
  return trimmed;
}
