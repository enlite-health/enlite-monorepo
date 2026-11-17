import type { Pool, PoolClient } from 'pg';
import type { IcdCategory, IcdCategoryLookupPort } from '../application/ports/IcdCategoryLookupPort';
import { ICD_CATEGORY_CODE_PATTERN } from '../domain/icdCategory';

type Queryable = Pick<Pool | PoolClient, 'query'>;

const MAX_RESULTS = 20;
// Release corrente (is_current) e só categoria: kind='stem' com código de exatamente 4 caracteres (parâmetro $1 = a constante do domínio).
const CURRENT_STEMS = `
  FROM terminology.icd_entities e
  JOIN terminology.icd_releases r ON r.release = e.release AND r.is_current
 WHERE e.kind = 'stem' AND e.code ~ $1`;
const TITLE = `COALESCE(e.title_es, e.title_en)`;

export const SEARCH_SQL = `
  SELECT DISTINCT ON (e.code) e.code, ${TITLE} AS title ${CURRENT_STEMS}
     AND (e.code ILIKE $2 OR e.title_es ILIKE $2 OR e.title_en ILIKE $2)
   ORDER BY e.code
   LIMIT $3`;

export const TITLES_SQL = `
  SELECT DISTINCT ON (e.code) e.code, ${TITLE} AS title ${CURRENT_STEMS} AND e.code = ANY($2::text[])
   ORDER BY e.code`;

const escapeLike = (raw: string): string => raw.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Adaptador Pg da porta de categorias; lê `terminology.icd_entities` do release corrente (índice (release, code), 586). */
export class PgIcdCategoryLookup implements IcdCategoryLookupPort {
  private readonly pattern = ICD_CATEGORY_CODE_PATTERN.source;

  constructor(private readonly db: Queryable) {}

  async search(query: string, limit: number = MAX_RESULTS): Promise<IcdCategory[]> {
    const cap = Math.min(Math.max(limit, 1), MAX_RESULTS);
    const { rows } = await this.db.query<IcdCategory>(SEARCH_SQL, [this.pattern, `%${escapeLike(query.trim())}%`, cap]);
    return rows;
  }

  async titlesByCode(codes: readonly string[]): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    const { rows } = await this.db.query<IcdCategory>(TITLES_SQL, [this.pattern, [...codes]]);
    return new Map(rows.map((r) => [r.code, r.title]));
  }

  async isCategory(code: string): Promise<boolean> {
    return (await this.titlesByCode([code])).has(code);
  }
}
