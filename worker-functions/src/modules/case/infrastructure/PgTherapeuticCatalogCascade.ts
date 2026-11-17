import type { Pool, PoolClient } from 'pg';
import type { TherapeuticCatalogCascadePort } from '../application/ports/TherapeuticCatalogCascadePort';
import type { CascadeActivity, CascadeObjective } from '../domain/TherapeuticDiagnosisPlan';

type Queryable = Pick<Pool | PoolClient, 'query'>;

// DD-4: a ordem mora no vínculo; NULL = vínculo criado na tela, depois dos da carga.
const ORDER = 'ORDER BY link.sort_order NULLS LAST, lower(item.label)';

export const OBJECTIVES_SQL = `
  SELECT link.category_code, item.id, item.label, item.description
    FROM therapeutic_objective_icd_categories link
    JOIN therapeutic_specific_objectives item ON item.id = link.objective_id
   WHERE item.active AND item.service_code = $1 AND link.category_code = ANY($2::text[])
   ${ORDER}`;

export const ACTIVITIES_SQL = `
  SELECT link.category_code, item.objective_id, item.id, item.label, item.description, item.suggested_frequency
    FROM therapeutic_activity_icd_categories link
    JOIN therapeutic_activities item ON item.id = link.activity_id
    JOIN therapeutic_specific_objectives obj ON obj.id = item.objective_id
   WHERE item.active AND obj.active AND obj.service_code = $1 AND link.category_code = ANY($2::text[])
   ${ORDER}`;

export const HAS_CATALOG_SQL = `
  SELECT EXISTS (SELECT 1 FROM therapeutic_specific_objectives WHERE active AND service_code = $1) AS has_catalog`;

interface ObjectiveRow { category_code: string; id: string; label: string; description: string | null }
interface ActivityRow {
  category_code: string; objective_id: string; id: string; label: string;
  description: string | null; suggested_frequency: string | null;
}

/** Adaptador Pg da porta da cascata. Recebe o cliente (pool ou o da transação do PTI); o SQL mora só aqui. */
export class PgTherapeuticCatalogCascade implements TherapeuticCatalogCascadePort {
  constructor(private readonly db: Queryable) {}

  async catalogFor(serviceCode: string, categoryCodes: readonly string[]): Promise<Map<string, CascadeObjective[]>> {
    const result = new Map<string, CascadeObjective[]>(categoryCodes.map((code) => [code, []]));
    if (categoryCodes.length === 0) return result;
    const params = [serviceCode, [...categoryCodes]];
    const [objectives, activities] = await Promise.all([
      this.db.query<ObjectiveRow>(OBJECTIVES_SQL, params),
      this.db.query<ActivityRow>(ACTIVITIES_SQL, params),
    ]);
    const byObjective = new Map<string, CascadeActivity[]>();
    for (const row of activities.rows) {
      const key = `${row.category_code}|${row.objective_id}`;
      const list = byObjective.get(key) ?? [];
      list.push({ id: row.id, label: row.label, description: row.description, suggestedFrequency: row.suggested_frequency });
      byObjective.set(key, list);
    }
    for (const row of objectives.rows) {
      result.get(row.category_code)?.push({
        id: row.id,
        label: row.label,
        description: row.description,
        activities: byObjective.get(`${row.category_code}|${row.id}`) ?? [],
      });
    }
    return result;
  }

  async hasCatalog(serviceCode: string): Promise<boolean> {
    const { rows } = await this.db.query<{ has_catalog: boolean }>(HAS_CATALOG_SQL, [serviceCode]);
    return rows[0]?.has_catalog === true;
  }
}
