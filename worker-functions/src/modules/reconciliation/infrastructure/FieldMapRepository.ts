/**
 * FieldMapRepository — source_field_map (migration 296).
 * O mapeamento é DADO, não código: a lista de campos do Ana Care (Javier,
 * PEND-03) vira linhas aqui, sem deploy.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { Equivalence, Source } from '../domain/enums';

export interface FieldMapEntry {
  readonly source: Source;
  readonly sourceField: string;
  readonly canonicalField: string;
  readonly equivalence: Equivalence;
  readonly enumMap: string | null;
  readonly active: boolean;
}

export class FieldMapRepository {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async activeFor(source: Source): Promise<FieldMapEntry[]> {
    const res = await this.pool.query<FieldMapEntry>(
      `SELECT source, source_field AS "sourceField", canonical_field AS "canonicalField",
              equivalence, enum_map AS "enumMap", active
         FROM source_field_map
        WHERE source = $1 AND active = TRUE
        ORDER BY source_field`,
      [source],
    );
    return res.rows;
  }
}
