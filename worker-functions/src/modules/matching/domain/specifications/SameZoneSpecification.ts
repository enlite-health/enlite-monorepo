import { MatchmakingSpecification, SqlClause, SqlClauseContext } from './MatchmakingSpecification';

export class SameZoneSpecification implements MatchmakingSpecification {
  constructor(
    private readonly radiusKm: number | null,
    private readonly centerLat: number | null,
    private readonly centerLng: number | null,
  ) {}

  toSqlClause(ctx: SqlClauseContext): SqlClause {
    const applyGeo = this.radiusKm !== null && this.centerLat !== null && this.centerLng !== null;
    const applyIndex  = ctx.paramOffset + 1;
    const lngIndex    = ctx.paramOffset + 2;
    const latIndex    = ctx.paramOffset + 3;
    const radiusIndex = ctx.paramOffset + 4;
    return {
      sql: `
        NOT $${applyIndex}::BOOLEAN
        OR ST_DWithin(
          wsa.location,
          ST_MakePoint($${lngIndex}::FLOAT, $${latIndex}::FLOAT)::geography,
          $${radiusIndex}::FLOAT * 1000
        )
      `,
      params: [
        applyGeo,
        applyGeo ? this.centerLng : 0,
        applyGeo ? this.centerLat : 0,
        this.radiusKm ?? 0,
      ],
    };
  }
}
