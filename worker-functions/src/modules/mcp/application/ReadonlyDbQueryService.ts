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

/**
 * Colunas de texto clínico restrito, proibidas em SQL ad-hoc:
 *   patients.emergency_instructions (D211.2) · patients.on_hold_note (spec 012, lex C7.1-d) ·
 *   patient_addresses.access_notes (spec 012, lex C2.1 — texto livre sobre o domicílio) ·
 *   patient_addresses.address_type_other (spec 019 — texto livre digitado por humano sobre a
 *   família do paciente ("Otro"); `address_type` — o enum fechado — NÃO entra aqui de propósito:
 *   o controle dele é o REVOKE de coluna (B1/B2, `create-mcp-ro-role.sql`), não a redação de log,
 *   porque esta regex protege contra vazamento de TEXTO em log/erro e o enum fechado já não entra
 *   em log — 0 hits medidos, ver spec.md "Segurança e perímetro").
 * O controle que vale é a role (create-mcp-ro-role.sql); isto é defesa em profundidade.
 */
export const RESTRICTED_CLINICAL_COLUMNS = /emergency_instructions|on_hold_note|access_notes|address_type_other/i;

/**
 * Tabelas com texto clínico livre (`patients`, `patient_*`). A view `patients_ro` (D216) fica
 * de fora de propósito: ela já nasce sem o texto, é o caminho recomendado para o conector.
 */
export const CLINICAL_TABLES = /\bpatients\b|\bpatient_\w+/i;

/**
 * Formas que devolvem a LINHA INTEIRA — e com ela `diagnosis`/`additional_comments`/
 * `emergency_instructions` — sem escrever o nome da coluna. A guarda por nome de coluna acima
 * não as vê; por isso, quando a query toca uma tabela clínica, estas são recusadas também.
 * `count(*)` NÃO projeta linha (item 1 da Regra: contagem sempre) e é neutralizado antes.
 */
export const WHOLE_ROW_PROJECTION = /(?:\bselect\s+(?:distinct\s+)?|,\s*|\(\s*)(?:\w+\.)?\*(?=[\s,)]|$)/i;
export const WHOLE_ROW_FUNCTIONS = /\b(?:to_jsonb|to_json|row_to_json|json_agg|jsonb_agg|hstore)\s*\(/i;

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
    throw new Error('Query touches a restricted clinical column (emergency_instructions, on_hold_note, access_notes)');
  }
  // Defesa em profundidade (D216): o controle que vale é a role `enlite_mcp_ro` com SELECT por
  // coluna (scripts/create-mcp-ro-role.sql). Esta camada só garante que `SELECT *`, `p.*`,
  // `to_jsonb(p)` e afins não cheguem ao banco quando a query toca `patients`/`patient_*`.
  if (CLINICAL_TABLES.test(trimmed)) {
    const semCount = trimmed.replace(/\bcount\s*\(\s*\*\s*\)/gi, 'count(1)');
    if (WHOLE_ROW_PROJECTION.test(semCount) || WHOLE_ROW_FUNCTIONS.test(semCount)) {
      throw new Error('Whole-row projection (*, alias.*, to_jsonb/row_to_json/json_agg/hstore) is not allowed on clinical tables (patients, patient_*); name the columns or use patients_ro');
    }
  }
  return trimmed;
}
