/**
 * src/shared/database/countryScopeSql.ts
 *
 * Predicado EXPLÍCITO de país para consultas de agregação (PR-9, `lex` #9,
 * L9-3/FR-732). Nunca depende da RLS: mesmo com `COUNTRY_RLS_ENABLED=false`
 * (o estado de PRD hoje — a virada ainda não aconteceu), a query já recorta
 * pelo país efetivo do ator porque o predicado está na própria SQL.
 *
 * `CHAR(n)`/`bpchar(n)` são o MESMO tipo interno do Postgres — `patients.country`
 * (`bpchar(2)`, migration 069) e `job_postings.country`/`workers.country`
 * (`CHAR(2)`, migrations 011/002) casam com o mesmo cast `::bpchar[]`.
 */

/**
 * Para queries que JÁ têm a tabela (`patients`, `job_postings`, `workers`) no
 * FROM/JOIN, sob o alias dado.
 *
 * @param alias alias da tabela na query (ex.: `p`, `jp`, `w`, ou o nome cru
 *   quando a query não usa alias).
 * @param paramIndex posição do parâmetro `$n` que carrega o array de países.
 */
export function countryPredicateSql(alias: string, paramIndex: number): string {
  return `${alias}.country = ANY($${paramIndex}::bpchar[])`;
}

/**
 * Para queries que só têm o `worker_id` à mão (sem JOIN a `workers`) — mesmo
 * padrão de `workerNotDisabledSql` em `activeWorkerFilter.ts`: um EXISTS
 * correlacionado, não uma reescrita do FROM.
 *
 * @param workerIdExpr expressão do worker_id (ex.: `wja.worker_id`).
 * @param paramIndex posição do parâmetro `$n` que carrega o array de países.
 */
export function workerCountryPredicateSql(workerIdExpr: string, paramIndex: number): string {
  return `EXISTS (
    SELECT 1 FROM workers w_country_chk
     WHERE w_country_chk.id = ${workerIdExpr}
       AND w_country_chk.country = ANY($${paramIndex}::bpchar[])
  )`;
}
