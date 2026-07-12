export interface SqlClause {
  sql: string;
  params: unknown[];
}

export interface SqlClauseContext {
  paramOffset: number;
}

export interface MatchmakingSpecification {
  toSqlClause(ctx: SqlClauseContext): SqlClause;
}

export function composeSpecifications(
  specifications: MatchmakingSpecification[],
  paramOffset: number,
): SqlClause {
  let offset = paramOffset;
  const sqlParts: string[] = [];
  const params: unknown[] = [];

  for (const specification of specifications) {
    const clause = specification.toSqlClause({ paramOffset: offset });
    sqlParts.push(`(${clause.sql})`);
    params.push(...clause.params);
    offset += clause.params.length;
  }

  return { sql: sqlParts.join(' AND '), params };
}
