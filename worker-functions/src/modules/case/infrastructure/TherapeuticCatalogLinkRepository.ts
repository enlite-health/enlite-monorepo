import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import type { IcdCategoryLookupPort } from '../application/ports/IcdCategoryLookupPort';
import type { CategoryLink, CategoryLinkList, TherapeuticCatalogLinkPort } from '../application/ports/TherapeuticCatalogLinkPort';
import { IcdCategoryCode, InvalidIcdCategoryCodeError } from '../domain/icdCategory';
import {
  CatalogLinkOwnerNotFoundError,
  IcdCategoryAlreadyLinkedError,
  IcdCategoryNotInObjectiveError,
} from '../domain/TherapeuticCatalogLinkErrors';
import { PgIcdCategoryLookup } from './PgIcdCategoryLookup';

// Códigos de erro do Postgres → erro de domínio (DD-23): o SQL e a tradução moram só neste adaptador.
const PG_UNIQUE = '23505';
const PG_FOREIGN_KEY = '23503';
const pgCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;

const OBJECTIVE_LINKS_SQL = `
  SELECT l.category_code AS code,
         (SELECT count(*)::int FROM therapeutic_activity_icd_categories a
           WHERE a.objective_id = l.objective_id AND a.category_code = l.category_code) AS activity_links
    FROM therapeutic_objective_icd_categories l
   WHERE l.objective_id = $1
   ORDER BY l.sort_order NULLS LAST, l.category_code`;
const ACTIVITY_LINKS_SQL = `
  SELECT category_code AS code FROM therapeutic_activity_icd_categories
   WHERE activity_id = $1 ORDER BY sort_order NULLS LAST, category_code`;
const COUNT_ACTIVITY_LINKS_SQL = `
  SELECT count(*)::int AS n FROM therapeutic_activity_icd_categories WHERE objective_id = $1 AND category_code = $2`;

/** Vínculos objetivo↔categoria e atividade↔categoria (DD-2, DD-16: sem vigência; remover apaga a linha). */
export type { CategoryLink, CategoryLinkList };
export class TherapeuticCatalogLinkRepository implements TherapeuticCatalogLinkPort {
  private poolMemo?: Pool;

  constructor(
    private readonly lookup?: IcdCategoryLookupPort,
    poolOverride?: Pool,
  ) {
    this.poolMemo = poolOverride;
  }

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  private get categories(): IcdCategoryLookupPort {
    return this.lookup ?? new PgIcdCategoryLookup(this.pool);
  }

  async listObjectiveCategories(objectiveId: string): Promise<CategoryLinkList> {
    const { rows } = await this.pool.query<{ code: string; activity_links: number }>(OBJECTIVE_LINKS_SQL, [objectiveId]);
    const titles = await this.categories.titlesByCode(rows.map((r) => r.code));
    const items = rows.map((r) => ({ code: r.code, title: titles.get(r.code) ?? null, activityLinks: r.activity_links }));
    return { total: items.length, items };
  }

  async listActivityCategories(activityId: string): Promise<CategoryLinkList> {
    const { rows } = await this.pool.query<{ code: string }>(ACTIVITY_LINKS_SQL, [activityId]);
    const titles = await this.categories.titlesByCode(rows.map((r) => r.code));
    const items = rows.map((r) => ({ code: r.code, title: titles.get(r.code) ?? null }));
    return { total: items.length, items };
  }

  /** Código tem de ser categoria do release corrente; senão `InvalidIcdCategoryCodeError` (422 icd_category_invalid). */
  async addObjectiveCategory(objectiveId: string, rawCode: string, actorUid: string): Promise<CategoryLink> {
    const code = IcdCategoryCode.parse(rawCode).value;
    const title = (await this.categories.titlesByCode([code])).get(code);
    if (title === undefined) throw new InvalidIcdCategoryCodeError();
    try {
      await this.pool.query(
        `INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, created_by) VALUES ($1, $2, $3)`,
        [objectiveId, code, actorUid],
      );
    } catch (err) {
      throw this.translateObjectiveInsert(err);
    }
    return { code, title };
  }

  /** DD-2: `objective_id` do vínculo vem da atividade (nunca do corpo HTTP); a FK composta barra categoria fora do objetivo. */
  async addActivityCategory(activityId: string, rawCode: string, actorUid: string): Promise<CategoryLink> {
    const code = IcdCategoryCode.parse(rawCode).value;
    let inserted: number | null;
    try {
      ({ rowCount: inserted } = await this.pool.query(
        `INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by)
         SELECT a.id, a.objective_id, $2, $3 FROM therapeutic_activities a WHERE a.id = $1 AND a.objective_id IS NOT NULL`,
        [activityId, code, actorUid],
      ));
    } catch (err) {
      throw this.translateActivityInsert(err);
    }
    if (!inserted) throw new CatalogLinkOwnerNotFoundError();
    const title = (await this.categories.titlesByCode([code])).get(code) ?? null;
    return { code, title };
  }

  /**
   * DD-23: conta os vínculos das atividades na mesma transação, apaga a categoria do objetivo (a FK cascateia) e relê 0.
   * Devolve a contagem do banco, não a de memória. Categoria já ausente: 0 (idempotente).
   */
  async removeObjectiveCategory(objectiveId: string, rawCode: string): Promise<{ removedActivityLinks: number }> {
    const code = IcdCategoryCode.parse(rawCode).value;
    return withActorContext(this.pool, async (cli: PoolClient) => {
      const before = await this.countActivityLinks(cli, objectiveId, code);
      await cli.query(
        `DELETE FROM therapeutic_objective_icd_categories WHERE objective_id = $1 AND category_code = $2`,
        [objectiveId, code],
      );
      const after = await this.countActivityLinks(cli, objectiveId, code);
      if (after !== 0) throw new Error('activity_links_remaining_after_category_removal');
      return { removedActivityLinks: before };
    });
  }

  async removeActivityCategory(activityId: string, rawCode: string): Promise<{ removed: boolean }> {
    const code = IcdCategoryCode.parse(rawCode).value;
    const { rowCount } = await this.pool.query(
      `DELETE FROM therapeutic_activity_icd_categories WHERE activity_id = $1 AND category_code = $2`,
      [activityId, code],
    );
    return { removed: (rowCount ?? 0) > 0 };
  }

  private async countActivityLinks(cli: PoolClient, objectiveId: string, code: string): Promise<number> {
    const { rows } = await cli.query<{ n: number }>(COUNT_ACTIVITY_LINKS_SQL, [objectiveId, code]);
    return rows[0]?.n ?? 0;
  }

  // 23505 = PK (já ligado); 23503 = objetivo inexistente.
  private translateObjectiveInsert(err: unknown): unknown {
    const code = pgCode(err);
    if (code === PG_UNIQUE) return new IcdCategoryAlreadyLinkedError();
    if (code === PG_FOREIGN_KEY) return new CatalogLinkOwnerNotFoundError();
    return err;
  }

  // 23505 = PK (já ligado); 23503 = FK composta dentro_do_objetivo (categoria fora do objetivo, DD-23).
  private translateActivityInsert(err: unknown): unknown {
    const code = pgCode(err);
    if (code === PG_UNIQUE) return new IcdCategoryAlreadyLinkedError();
    if (code === PG_FOREIGN_KEY) return new IcdCategoryNotInObjectiveError();
    return err;
  }
}
