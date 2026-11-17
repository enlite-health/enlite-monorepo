import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import {
  THERAPEUTIC_CATALOG_TABLE,
  catalogHasDescription,
  type TherapeuticCatalogKind,
  type TherapeuticCatalogSnapshotItem,
} from '../domain/TherapeuticProject';
import { SERVICE_EXIT_REASON_KIND, SERVICE_EXIT_REASON_TABLE, type AdminCatalogKind } from '../domain/serviceExitReason';

export interface CatalogItem {
  id: string;
  label: string;
  sortOrder: number;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Só o catálogo de motivos de saída (migration 492) — código estável que as marcas referenciam. */
  code?: string;
  /** Só objetivos/atividades (migration 547). */
  description?: string | null;
  /** Só objetivos (091): serviço dono do objetivo. */
  serviceCode?: string | null;
  /** Objetivos e atividades (091): quantas categorias CID-11 o item tem vinculadas (derivado, nunca gravado). */
  categoryCount?: number;
  /** Só atividades (091): objetivo dono, seu rótulo/estado e a frequência sugerida. */
  objectiveId?: string | null;
  objectiveLabel?: string | null;
  objectiveActive?: boolean | null;
  suggestedFrequency?: string | null;
}

interface CatalogRow {
  id: string;
  label: string;
  sort_order: number;
  active: boolean;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
  code?: string;
  description?: string | null;
  service_code?: string | null;
  category_count?: number;
  objective_id?: string | null;
  objective_label?: string | null;
  objective_active?: boolean | null;
  suggested_frequency?: string | null;
}

/** Filtros do `list` (091). Cada kind só honra os que tem em `LIST_SHAPE.filters`. */
export interface CatalogListOptions {
  includeInactive?: boolean;
  categoryCode?: string;
  objectiveId?: string;
}

/** Campos de escrita de objetivos/atividades (091). Chave ausente = não toca a coluna (Merge Patch). */
export interface CatalogWriteFields {
  label?: string;
  sortOrder?: number;
  description?: string | null;
  serviceCode?: string | null;
  objectiveId?: string | null;
  suggestedFrequency?: string | null;
}

/** Rótulo já existe entre os ATIVOS (índice `uq_<tabela>_<dono>_label_ativo`, 415/586). */
export class CatalogLabelTakenError extends Error {
  readonly code = 'catalog_label_taken';
  constructor() {
    super('catalog_label_taken');
  }
}

/** Ids pedidos que não existem ou estão inativos — o snapshot só congela o que está no catálogo (lex C19). */
export class CatalogItemsUnknownError extends Error {
  readonly code = 'catalog_items_unknown';
  constructor(readonly kind: TherapeuticCatalogKind, readonly ids: string[]) {
    super('catalog_items_unknown');
  }
}

/** Item ATIVO sem dono (serviço/objetivo) — CHECK da 586 (DD-15). 422 sem ecoar nada. */
export class CatalogItemNeedsOwnerError extends Error {
  readonly code = 'catalog_item_needs_owner';
  constructor() {
    super('catalog_item_needs_owner');
  }
}

/** Troca de objetivo deixaria vínculos da atividade com categorias que o novo objetivo não tem (FK composta, DD-23). */
export class ActivityCategoriesOutsideObjectiveError extends Error {
  readonly code = 'activity_categories_outside_objective';
  constructor() {
    super('activity_categories_outside_objective');
  }
}

/** `objectiveId` da atividade não existe (FK `therapeutic_activities_objective_id_fkey`, 23503) — POST/PATCH, 422 sem ecoar o id. */
export class CatalogObjectiveInvalidError extends Error {
  readonly code = 'catalog_objective_invalid';
  constructor() {
    super('catalog_objective_invalid');
  }
}

/** Tabela por kind: os terapêuticos (domínio) + o de motivos de saída, que NÃO entra em `THERAPEUTIC_CATALOG_TABLE`. */
const ADMIN_CATALOG_TABLE: Readonly<Record<AdminCatalogKind, string>> = {
  ...THERAPEUTIC_CATALOG_TABLE,
  [SERVICE_EXIT_REASON_KIND]: SERVICE_EXIT_REASON_TABLE,
};

/**
 * Tradução SQLSTATE+constraint → erro de domínio, por TABELA (Strategy por entrada, sem cadeia de if).
 * O que não casa propaga cru (500 honesto, nunca 4xx mentiroso).
 */
interface PgTranslation { sqlstate: string; constraint: RegExp; make: () => Error }
const PG_TRANSLATIONS: readonly PgTranslation[] = [
  { sqlstate: '23505', constraint: /_label_ativo/, make: () => new CatalogLabelTakenError() },
  { sqlstate: '23514', constraint: /^therapeutic_(specific_objectives_ativo_tem_servico|activities_ativa_tem_objetivo)$/, make: () => new CatalogItemNeedsOwnerError() },
  { sqlstate: '23503', constraint: /^therapeutic_activity_icd_categories_dentro_do_objetivo_fk$/, make: () => new ActivityCategoriesOutsideObjectiveError() },
  { sqlstate: '23503', constraint: /^therapeutic_activities_objective_id_fkey$/, make: () => new CatalogObjectiveInvalidError() },
];

const translatePgError = (err: unknown): unknown => {
  if (typeof err !== 'object' || err === null) return err;
  const { code, constraint } = err as { code?: string; constraint?: string };
  const hit = PG_TRANSLATIONS.find((t) => t.sqlstate === code && t.constraint.test(String(constraint ?? '')));
  return hit ? hit.make() : err;
};

/** Colunas da linha que entram no item só quando a linha as TEM (objetivos/atividades/motivos de saída têm formas diferentes). */
const OPTIONAL_ITEM_FIELDS: ReadonlyArray<readonly [keyof CatalogRow, keyof CatalogItem]> = [
  ['code', 'code'],
  ['description', 'description'],
  ['service_code', 'serviceCode'],
  ['category_count', 'categoryCount'],
  ['objective_id', 'objectiveId'],
  ['objective_label', 'objectiveLabel'],
  ['objective_active', 'objectiveActive'],
  ['suggested_frequency', 'suggestedFrequency'],
];

const toItem = (r: CatalogRow): CatalogItem => {
  const item: CatalogItem = {
    id: r.id,
    label: r.label,
    sortOrder: r.sort_order,
    active: r.active,
    deactivatedAt: r.deactivated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  // Só entra quando a linha TEM a coluna: o mock/linha sem a chave não ganha `x: undefined` (quebraria o `toEqual`).
  OPTIONAL_ITEM_FIELDS.forEach(([from, to]) => {
    if (r[from] !== undefined) (item as unknown as Record<string, unknown>)[to] = r[from];
  });
  return item;
};

/** Colunas de dono/extras por kind (Strategy por tabela): campo de entrada → coluna. Kind ausente = só label/sort/description. */
const OWNED_COLUMNS: Partial<Record<AdminCatalogKind, ReadonlyArray<readonly [keyof CatalogWriteFields, string]>>> = {
  'specific-objectives': [['serviceCode', 'service_code']],
  activities: [['objectiveId', 'objective_id'], ['suggestedFrequency', 'suggested_frequency']],
};

/** Forma do SELECT por kind (Strategy por tabela): base, coluna `active` e filtros disponíveis. */
interface ListShape {
  base: (table: string) => string;
  activeCol: string;
  filters: Partial<Record<keyof Omit<CatalogListOptions, 'includeInactive'>, (ph: string) => string>>;
  orderBy: string;
}
const OBJECTIVE_SHAPE: ListShape = {
  base: (t) => `SELECT o.*, (SELECT COUNT(*)::int FROM therapeutic_objective_icd_categories l WHERE l.objective_id = o.id) AS category_count FROM ${t} o`,
  activeCol: 'o.active',
  filters: { categoryCode: (ph) => `EXISTS (SELECT 1 FROM therapeutic_objective_icd_categories f WHERE f.objective_id = o.id AND f.category_code = ${ph})` },
  orderBy: 'lower(o.label)',
};
const ACTIVITY_SHAPE: ListShape = {
  base: (t) => `SELECT a.*, ob.label AS objective_label, ob.active AS objective_active, (SELECT COUNT(*)::int FROM therapeutic_activity_icd_categories l WHERE l.activity_id = a.id) AS category_count FROM ${t} a LEFT JOIN therapeutic_specific_objectives ob ON ob.id = a.objective_id`,
  activeCol: 'a.active',
  filters: {
    categoryCode: (ph) => `EXISTS (SELECT 1 FROM therapeutic_activity_icd_categories f WHERE f.activity_id = a.id AND f.category_code = ${ph})`,
    objectiveId: (ph) => `a.objective_id = ${ph}`,
  },
  orderBy: 'lower(a.label)',
};
const MANUAL_ORDER_SHAPE: ListShape = { base: (t) => `SELECT * FROM ${t}`, activeCol: 'active', filters: {}, orderBy: 'active DESC, sort_order, lower(label)' };
const LIST_SHAPE: Readonly<Record<AdminCatalogKind, ListShape>> = {
  'specific-objectives': OBJECTIVE_SHAPE,
  activities: ACTIVITY_SHAPE,
  [SERVICE_EXIT_REASON_KIND]: MANUAL_ORDER_SHAPE,
};

/**
 * Os catálogos do projeto terapêutico (migration 415, 586) — UM repositório, a tabela vem do domínio
 * (`THERAPEUTIC_CATALOG_TABLE`), nunca de string do cliente. Sem `country`: lista global.
 * Baixa é `active=false` + `deactivated_at`, nunca DELETE (versões antigas apontam para o id).
 */
export class TherapeuticCatalogRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  private table(kind: AdminCatalogKind): string {
    return ADMIN_CATALOG_TABLE[kind];
  }

  async list(kind: AdminCatalogKind, opts: CatalogListOptions = {}): Promise<CatalogItem[]> {
    const shape = LIST_SHAPE[kind];
    const params: unknown[] = [];
    const conds: string[] = opts.includeInactive ? [] : [shape.activeCol];
    (Object.keys(shape.filters) as Array<keyof ListShape['filters']>).forEach((key) => {
      const value = opts[key];
      if (value === undefined) return;
      params.push(value);
      conds.push(shape.filters[key]!(`$${params.length}`));
    });
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const res = await this.pool.query<CatalogRow>(
      `${shape.base(this.table(kind))} ${where} ORDER BY ${shape.orderBy}`,
      params,
    );
    return res.rows.map(toItem);
  }

  /**
   * O snapshot que a versão congela: só ids ATIVOS. Id desconhecido/inativo → erro nomeado com a
   * lista (o controller responde 422 com os ids, nunca grava pela metade).
   */
  async snapshotOf(kind: TherapeuticCatalogKind, ids: readonly string[], cli: Pool | PoolClient = this.pool): Promise<TherapeuticCatalogSnapshotItem[]> {
    const unique = [...new Set(ids)];
    const res = await cli.query<{ id: string; label: string; description: string | null }>(
      `SELECT c.id, c.label, c.description
         FROM ${this.table(kind)} c
        WHERE c.active AND c.id = ANY($1::uuid[]) ORDER BY c.sort_order, lower(c.label)`,
      [unique],
    );
    const found = new Set(res.rows.map((r) => r.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) throw new CatalogItemsUnknownError(kind, missing);
    return res.rows.map((r) => ({ id: r.id, label: r.label, ...(r.description ? { description: r.description } : {}) }));
  }

  async create(kind: AdminCatalogKind, input: CatalogWriteFields & { label: string; actorUid: string }): Promise<CatalogItem> {
    try {
      const row = await withActorContext(this.pool, async (cli) => {
        // Cada coluna só entra quando o CHAMADOR mandou a chave (ausente não toca a coluna, mesmo Merge Patch do `update`).
        const cols = ['label', 'sort_order'];
        const params: unknown[] = [input.label, input.sortOrder ?? null];
        const placeholders = ['$1', `COALESCE($2, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM ${this.table(kind)}))`];
        const add = (col: string, value: unknown): void => {
          params.push(value);
          cols.push(col);
          placeholders.push(`$${params.length}`);
        };
        (OWNED_COLUMNS[kind] ?? []).forEach(([field, col]) => {
          if (input[field] !== undefined) add(col, input[field]);
        });
        if (catalogHasDescription(kind) && input.description !== undefined) add('description', input.description);
        params.push(input.actorUid);
        cols.push('created_by', 'updated_by');
        placeholders.push(`$${params.length}`, `$${params.length}`);
        const res = await cli.query<CatalogRow>(
          `INSERT INTO ${this.table(kind)} (${cols.join(', ')})
           VALUES (${placeholders.join(', ')})
           RETURNING *`,
          params,
        );
        return res.rows[0];
      });
      return toItem(row);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  /** Merge Patch: chave ausente não toca a coluna. `active:false` carimba `deactivated_at`; `true` limpa. */
  async update(
    kind: AdminCatalogKind,
    id: string,
    patch: CatalogWriteFields & { active?: boolean; actorUid: string },
  ): Promise<CatalogItem | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.label !== undefined) push('label', patch.label);
    if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder);
    (OWNED_COLUMNS[kind] ?? []).forEach(([field, col]) => {
      if (patch[field] !== undefined) push(col, patch[field]);
    });
    if (catalogHasDescription(kind) && patch.description !== undefined) push('description', patch.description);
    if (patch.active !== undefined) {
      push('active', patch.active);
      sets.push(patch.active ? 'deactivated_at = NULL' : 'deactivated_at = NOW()');
    }
    push('updated_by', patch.actorUid);
    sets.push('updated_at = NOW()');
    try {
      const row = await withActorContext(this.pool, async (cli) => {
        const res = await cli.query<CatalogRow>(
          `UPDATE ${this.table(kind)} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
          params,
        );
        return res.rows[0] ?? null;
      });
      return row ? toItem(row) : null;
    } catch (err) {
      throw translatePgError(err);
    }
  }
}
