import { DataRealm } from '@shared/domain/DataRealm';
import { MatchmakingSpecification, SqlClause, SqlClauseContext } from './MatchmakingSpecification';

export class SameRealmSpecification implements MatchmakingSpecification {
  constructor(private readonly realm: DataRealm) {}

  toSqlClause(ctx: SqlClauseContext): SqlClause {
    const paramIndex = ctx.paramOffset + 1;
    return {
      sql: `w.is_test = $${paramIndex}::boolean`,
      params: [this.realm.toIsTest()],
    };
  }
}
