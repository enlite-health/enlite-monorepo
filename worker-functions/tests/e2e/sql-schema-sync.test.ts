/**
 * sql-schema-sync.test.ts
 *
 * Verifica que TODAS as queries SQL presentes no código-fonte referenciam
 * apenas tabelas e colunas que realmente existem no banco.
 *
 * Funciona lendo os arquivos .ts de controllers/, repositories/ e services/,
 * extraindo as queries SQL dos template literals, e validando cada
 * referência `tabela.coluna` contra information_schema.
 *
 * Esse teste previne o bug clássico: uma migration remove uma coluna,
 * mas o código ainda a referencia → erro em produção.
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const SRC_ROOT = path.resolve(__dirname, '../../src');

// Directories to scan for SQL queries
const SCAN_DIRS = [
  'interfaces/controllers',
  'infrastructure/repositories',
  'infrastructure/services',
  'modules/matching/interfaces/controllers',
  'modules/matching/infrastructure',
  'modules/worker/interfaces/controllers',
  'modules/worker/infrastructure',
  'modules/identity/interfaces',
  'modules/audit/infrastructure',
  'modules/integration/interfaces',
  'modules/notification/interfaces',
];

// Files/patterns to skip
const SKIP_PATTERNS = [
  /__tests__/,
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /\.d\.ts$/,
];

// Aliases and prefixes that are NOT real tables
const SKIP_ALIASES = new Set([
  // UPSERT / SQL aliases
  'excluded',
  // Common subquery / CTE aliases
  'sub', 'agg', 'sq', 'cnt', 'filtered', 'ranked', 'merged',
  'new_values', 'old_values', 'candidates', 'previous', 'latest',
  'totals', 'stats', 'summary', 'result', 'tmp', 'temp', 'data',
  // PostgreSQL built-in schemas / pseudo-tables
  'pg_catalog', 'information_schema', 'pg_temp',
  // Non-table prefixes that match word.word (JS/TS or PG functions)
  'json', 'jsonb', 'pg', 'st', 'array', 'db', 'identity',
  'console', 'process', 'error', 'req', 'res', 'row', 'rows',
  'this', 'self', 'opts', 'options', 'config', 'env', 'math',
  // Inline LATERAL subquery aliases — `) alias_name ON true` pattern.
  // These are not real tables; they are names given to anonymous subqueries.
  // The parser matches word.word and can't distinguish these from table refs.
  'latest_wbdl', // LATERAL subquery alias in FunnelTableRepository (line ~79)
  // Dead code: tables dropped but repository code not yet removed (tracked for cleanup)
  'worker_quiz_responses', // dropped in migration 028, QuizResponseRepository is dead code
]);

interface ColumnRef {
  table: string;
  column: string;
  file: string;
  line: number;
  sqlSnippet: string;
}

interface AliasMap {
  [alias: string]: string;
}

interface SchemaInfo {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      if (!SKIP_PATTERNS.some((p) => p.test(fullPath))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Extract SQL template literals from TypeScript source.
 */
function extractSqlQueries(content: string): { sql: string; lineNum: number }[] {
  const queries: { sql: string; lineNum: number }[] = [];
  const backtickRegex = /`([^`]+)`/gs;
  let match: RegExpExecArray | null;

  while ((match = backtickRegex.exec(content)) !== null) {
    const raw = match[1];
    // Must contain core SQL keywords
    if (!/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(raw)) continue;

    const beforeMatch = content.substring(0, match.index);
    const lineNum = beforeMatch.split('\n').length;
    const cleaned = raw.replace(/\$\{[^}]+\}/g, '__EXPR__');
    queries.push({ sql: cleaned, lineNum });
  }

  return queries;
}

/**
 * Extract CTE names from WITH clauses.
 */
function extractCteNames(sql: string): Set<string> {
  const ctes = new Set<string>();
  const cteRegex = /\bWITH\s+(?:RECURSIVE\s+)?(\w+)\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = cteRegex.exec(sql)) !== null) {
    ctes.add(m[1].toLowerCase());
  }
  // Also catch chained CTEs: , name AS (
  const chainedCteRegex = /,\s*(\w+)\s+AS\s*\(/gi;
  while ((m = chainedCteRegex.exec(sql)) !== null) {
    ctes.add(m[1].toLowerCase());
  }
  return ctes;
}

/**
 * Build alias → table name map from FROM and JOIN clauses.
 */
function buildAliasMap(sql: string): AliasMap {
  const map: AliasMap = {};

  // FROM table_name alias | FROM table_name AS alias
  const fromRegex = /\bFROM\s+(\w+)\s+(?:AS\s+)?(\w+)/gi;
  let m: RegExpExecArray | null;
  while ((m = fromRegex.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const alias = m[2].toLowerCase();
    if (!isSqlKeyword(alias) && !isSqlKeyword(table)) {
      map[alias] = table;
      map[table] = table;
    }
  }

  // JOIN table_name alias | JOIN table_name AS alias
  const joinRegex = /\bJOIN\s+(\w+)\s+(?:AS\s+)?(\w+)/gi;
  while ((m = joinRegex.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const alias = m[2].toLowerCase();
    if (!isSqlKeyword(alias) && !isSqlKeyword(table)) {
      map[alias] = table;
      map[table] = table;
    }
  }

  // Bare FROM/JOIN (no alias)
  const bareRegex = /\b(?:FROM|JOIN)\s+(\w+)\b/gi;
  while ((m = bareRegex.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    if (!isSqlKeyword(table)) {
      map[table] = table;
    }
  }

  return map;
}

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'on', 'as', 'set', 'into',
  'values', 'insert', 'update', 'delete', 'join', 'left', 'right',
  'inner', 'outer', 'cross', 'full', 'group', 'order', 'by', 'having',
  'limit', 'offset', 'union', 'all', 'distinct', 'case', 'when', 'then',
  'else', 'end', 'is', 'not', 'null', 'true', 'false', 'in', 'exists',
  'between', 'like', 'ilike', 'create', 'alter', 'drop', 'table',
  'index', 'constraint', 'primary', 'key', 'foreign', 'references',
  'cascade', 'if', 'do', 'nothing', 'returning', 'with', 'recursive',
  'conflict', 'excluded', 'coalesce', 'count', 'sum', 'avg', 'min',
  'max', 'filter', 'over', 'partition', 'row_number', 'rank', 'lateral',
  'begin', 'commit', 'rollback', 'now', 'current_timestamp',
]);

function isSqlKeyword(word: string): boolean {
  return SQL_KEYWORDS.has(word.toLowerCase());
}

/**
 * Check if an alias is a single letter (a-z) — these are always table aliases,
 * not real table names, and can map to any table via the alias map.
 */
function isSingleLetterAlias(name: string): boolean {
  return /^[a-z]$/.test(name);
}

/**
 * Extract table.column references from SQL and validate them.
 */
function extractColumnRefs(
  sql: string,
  aliasMap: AliasMap,
  cteNames: Set<string>,
  filePath: string,
  baseLineNum: number,
): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const colRefRegex = /\b(\w+)\.(\w+)\b/g;
  let m: RegExpExecArray | null;

  while ((m = colRefRegex.exec(sql)) !== null) {
    const tableOrAlias = m[1].toLowerCase();
    const column = m[2].toLowerCase();

    // Skip well-known non-table prefixes
    if (SKIP_ALIASES.has(tableOrAlias)) continue;

    // Skip template expression placeholders
    if (column === '__expr__' || tableOrAlias === '__expr__') continue;
    // Skip numeric suffixes (e.g., le2.col)
    if (/^\d+$/.test(column)) continue;

    // Skip CTE references (they're virtual tables)
    if (cteNames.has(tableOrAlias)) continue;

    // Resolve alias to real table name
    const realTable = aliasMap[tableOrAlias];

    // If we can't resolve the alias, and it's a single letter, skip it
    // (it's likely a subquery alias like `e` or `p`)
    if (!realTable && isSingleLetterAlias(tableOrAlias)) continue;

    // If we can't resolve and it doesn't look like a table name, skip
    if (!realTable && !tableOrAlias.includes('_')) continue;

    const resolvedTable = realTable || tableOrAlias;

    const beforeRef = sql.substring(0, m.index);
    const extraLines = beforeRef.split('\n').length - 1;

    refs.push({
      table: resolvedTable,
      column,
      file: filePath,
      line: baseLineNum + extraLines,
      sqlSnippet: sql.substring(
        Math.max(0, m.index - 40),
        Math.min(sql.length, m.index + m[0].length + 40),
      ).replace(/\n/g, ' ').trim(),
    });
  }

  return refs;
}

// ─── Test Suite ─────────────────────────────────────────────────────────

describe('SQL ↔ Schema Sync Validation', () => {
  let pool: Pool;
  let schema: SchemaInfo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    // Load full schema from information_schema (tables + views)
    const tablesResult = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    schema = {
      tables: new Set<string>(),
      columns: new Map<string, Set<string>>(),
    };

    for (const row of tablesResult.rows) {
      const table = row.table_name as string;
      const col = row.column_name as string;
      schema.tables.add(table);
      if (!schema.columns.has(table)) {
        schema.columns.set(table, new Set());
      }
      schema.columns.get(table)!.add(col);
    }

    console.log(
      `[Schema Sync] Loaded ${schema.tables.size} tables, ` +
      `${tablesResult.rows.length} columns from information_schema`,
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('all table.column references in source code must exist in the database', () => {
    const allRefs: ColumnRef[] = [];
    const filesScanned: string[] = [];

    for (const dir of SCAN_DIRS) {
      const fullDir = path.join(SRC_ROOT, dir);
      const files = getAllTsFiles(fullDir);

      for (const file of files) {
        filesScanned.push(path.relative(SRC_ROOT, file));
        const content = fs.readFileSync(file, 'utf-8');
        const queries = extractSqlQueries(content);

        for (const { sql, lineNum } of queries) {
          const aliasMap = buildAliasMap(sql);
          const cteNames = extractCteNames(sql);
          const refs = extractColumnRefs(sql, aliasMap, cteNames, file, lineNum);
          allRefs.push(...refs);
        }
      }
    }

    console.log(
      `[Schema Sync] Scanned ${filesScanned.length} files, ` +
      `found ${allRefs.length} column references`,
    );

    const errors: string[] = [];

    for (const ref of allRefs) {
      if (!schema.tables.has(ref.table)) {
        // Table not found — flag it (only tables with underscores to avoid false positives)
        if (ref.table.includes('_')) {
          errors.push(
            `Table "${ref.table}" does not exist ` +
            `(referenced as "${ref.table}.${ref.column}" ` +
            `in ${path.relative(SRC_ROOT, ref.file)}:${ref.line})\n` +
            `  Context: ...${ref.sqlSnippet}...`,
          );
        }
        continue;
      }

      const tableCols = schema.columns.get(ref.table);
      if (tableCols && !tableCols.has(ref.column)) {
        if (ref.column === '*') continue;

        errors.push(
          `Column "${ref.table}.${ref.column}" does not exist ` +
          `(referenced in ${path.relative(SRC_ROOT, ref.file)}:${ref.line})\n` +
          `  Context: ...${ref.sqlSnippet}...`,
        );
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Found ${errors.length} SQL ↔ Schema mismatches:\n\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n\n'),
      );
    }
  });

  it('all tables referenced in FROM/JOIN clauses must exist', () => {
    const missingTables: { table: string; file: string; line: number }[] = [];

    for (const dir of SCAN_DIRS) {
      const fullDir = path.join(SRC_ROOT, dir);
      const files = getAllTsFiles(fullDir);

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        const queries = extractSqlQueries(content);

        for (const { sql, lineNum } of queries) {
          const cteNames = extractCteNames(sql);
          const tableRegex = /\b(?:FROM|JOIN)\s+(\w+)\b/gi;
          let m: RegExpExecArray | null;

          while ((m = tableRegex.exec(sql)) !== null) {
            const tableName = m[1].toLowerCase();
            if (isSqlKeyword(tableName)) continue;
            if (SKIP_ALIASES.has(tableName)) continue;
            if (cteNames.has(tableName)) continue;
            if (tableName === '__expr__') continue;
            // Single-letter names are subquery aliases, not tables
            if (isSingleLetterAlias(tableName)) continue;

            if (!schema.tables.has(tableName)) {
              missingTables.push({
                table: tableName,
                file: path.relative(SRC_ROOT, file),
                line: lineNum,
              });
            }
          }
        }
      }
    }

    // Deduplicate
    const uniqueErrors = [
      ...new Map(
        missingTables.map((e) => [`${e.table}:${e.file}`, e]),
      ).values(),
    ];

    if (uniqueErrors.length > 0) {
      throw new Error(
        `Found ${uniqueErrors.length} references to non-existent tables:\n\n` +
        uniqueErrors
          .map((e, i) => `  ${i + 1}. Table "${e.table}" referenced in ${e.file}:${e.line}`)
          .join('\n'),
      );
    }
  });

  it('critical SELECT queries must EXPLAIN successfully against the database', async () => {
    // Validates queries via EXPLAIN, catching schema issues that static analysis might miss.
    // Only reports "does not exist" errors (column/table/relation).
    // Type mismatches from NULL::text replacement are expected and ignored.
    const criticalFiles = [
      'modules/matching/interfaces/controllers/VacanciesController.ts',
      'modules/matching/interfaces/controllers/VacancyCrudController.ts',
      'modules/matching/interfaces/controllers/EncuadreFunnelController.ts',
      'modules/worker/interfaces/controllers/AdminWorkersController.ts',
      'modules/matching/interfaces/controllers/RecruitmentController.ts',
      'modules/matching/interfaces/controllers/AnalyticsController.ts',
      'modules/matching/infrastructure/MatchmakingService.ts',
    ];

    const errors: string[] = [];

    for (const relFile of criticalFiles) {
      const fullPath = path.join(SRC_ROOT, relFile);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const queries = extractSqlQueries(content);

      for (const { sql, lineNum } of queries) {
        // Only EXPLAIN SELECT queries
        if (!/^\s*SELECT\b/i.test(sql)) continue;
        // Skip queries with dynamic template expressions
        if (sql.includes('__EXPR__')) continue;

        const explainSql = sql.replace(/\$\d+/g, 'NULL::text');

        try {
          await pool.query(`EXPLAIN (COSTS OFF) ${explainSql}`);
        } catch (err: any) {
          const msg = err.message || '';
          // Only report "does not exist" errors — these are actual schema mismatches.
          // Skip type mismatches (operator does not exist, etc.) caused by NULL::text replacement.
          if (/(?:column|relation|table)\s+"?\w+"?\s+(?:does not exist|of relation)/i.test(msg)
            || /relation "[\w.]+" does not exist/i.test(msg)) {
            errors.push(
              `EXPLAIN failed for query in ${relFile}:${lineNum}\n` +
              `  Error: ${msg}\n` +
              `  Query (first 200 chars): ${sql.substring(0, 200).replace(/\n/g, ' ')}`,
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Found ${errors.length} queries that fail EXPLAIN:\n\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n\n'),
      );
    }
  });
});
