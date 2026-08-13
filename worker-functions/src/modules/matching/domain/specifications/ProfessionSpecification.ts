import { MatchmakingSpecification, SqlClause, SqlClauseContext } from './MatchmakingSpecification';

export class ProfessionSpecification implements MatchmakingSpecification {
  constructor(private readonly requiredProfessions: string[] | null) {}

  toSqlClause(ctx: SqlClauseContext): SqlClause {
    const paramIndex = ctx.paramOffset + 1;
    return {
      sql: `$${paramIndex}::JSONB IS NULL OR $${paramIndex}::JSONB ? COALESCE(w.occupation, w.profession)`,
      params: [this.requiredProfessions !== null ? JSON.stringify(this.requiredProfessions) : null],
    };
  }
}
