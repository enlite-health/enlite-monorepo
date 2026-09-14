import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import {
  THERAPEUTIC_CATALOG_TABLE,
  type TherapeuticCatalogKind,
  type TherapeuticCatalogSnapshotItem,
} from '../domain/TherapeuticProject';

export interface CatalogItem {
  id: string;
  label: string;
  sortOrder: number;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Só objetivos/atividades (migration 430) — a tabela `therapeutic_segments` não tem esta coluna. */
  segmentId?: string | null;
}

interface CatalogRow {
  id: string;
  label: string;
  sort_order: number;
  active: boolean;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
  segment_id?: string | null;
}

/** Rótulo já existe entre os ATIVOS (índice `uq_<tabela>_label_ativo`, 415). */
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

/** `segmentId` (430) referenciado não é um segmento ATIVO — 422 SEM ecoar o id (nenhum campo aqui). */
export class CatalogSegmentInvalidError extends Error {
  readonly code = 'catalog_segment_invalid';
  constructor() {
    super('catalog_segment_invalid');
  }
}

const isLabelUnique = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
  && /_label_ativo/.test(String((err as { constraint?: string }).constraint ?? ''));

const toItem = (r: CatalogRow): CatalogItem => ({
  id: r.id,
  label: r.label,
  sortOrder: r.sort_order,
  active: r.active,
  deactivatedAt: r.deactivated_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  // Só entra quando a linha TEM a coluna (objetivos/atividades) — `segments` não tem `segment_id`,
  // e o mock de teste sem a chave não pode ganhar `segmentId: undefined` (quebraria o `toEqual` exato).
  ...(r.segment_id !== undefined ? { segmentId: r.segment_id } : {}),
});

/**
 * Os 3 catálogos do projeto terapêutico (migration 415) — UM repositório, a tabela vem do domínio
 * (`THERAPEUTIC_CATALOG_TABLE`), nunca de string do cliente. Sem `country`: lista global.
 * Baixa é `active=false` + `deactivated_at`, nunca DELETE (versões antigas apontam para o id).
 */
export class TherapeuticCatalogRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  private table(kind: TherapeuticCatalogKind): string {
    return THERAPEUTIC_CATALOG_TABLE[kind];
  }

  async list(kind: TherapeuticCatalogKind, opts: { includeInactive?: boolean } = {}): Promise<CatalogItem[]> {
    const where = opts.includeInactive ? '' : 'WHERE active';
    const res = await this.pool.query<CatalogRow>(
      `SELECT * FROM ${this.table(kind)} ${where} ORDER BY active DESC, sort_order, lower(label)`,
    );
    return res.rows.map(toItem);
  }

  /**
   * O snapshot que a versão congela: só ids ATIVOS. Id desconhecido/inativo → erro nomeado com a
   * lista (o controller responde 422 com os ids, nunca grava pela metade). `segmentId`/`segmentLabel`
   * (migration 430) entram no congelamento — quem os REDIGE por célula é `therapeuticProjectAccess.ts`
   * (lex-pr7 C3(b)), nunca aqui.
   */
  async snapshotOf(kind: TherapeuticCatalogKind, ids: readonly string[], cli: Pool | PoolClient = this.pool): Promise<TherapeuticCatalogSnapshotItem[]> {
    const unique = [...new Set(ids)];
    const res = await cli.query<{ id: string; label: string; segment_id: string | null; segment_label: string | null }>(
      `SELECT c.id, c.label, c.segment_id, s.label AS segment_label
         FROM ${this.table(kind)} c
         LEFT JOIN therapeutic_segments s ON s.id = c.segment_id
        WHERE c.active AND c.id = ANY($1::uuid[]) ORDER BY c.sort_order, lower(c.label)`,
      [unique],
    );
    const found = new Set(res.rows.map((r) => r.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) throw new CatalogItemsUnknownError(kind, missing);
    return res.rows.map((r) => ({ id: r.id, label: r.label, segmentId: r.segment_id, segmentLabel: r.segment_label }));
  }

  /**
   * `segmentId` (430) — só um `segmento` ATIVO pode ser referenciado; `null` limpa o vínculo sem
   * checar nada. Fora da transação de escrita (leitura pura, antes do INSERT/UPDATE) — mesmo
   * desenho do `snapshotOf` para os ids de catálogo (lex C19).
   */
  private async assertSegmentActive(segmentId: string): Promise<void> {
    const res = await this.pool.query<{ ok: number }>(
      'SELECT 1 AS ok FROM therapeutic_segments WHERE id = $1 AND active',
      [segmentId],
    );
    if (res.rows.length === 0) throw new CatalogSegmentInvalidError();
  }

  async create(kind: TherapeuticCatalogKind, input: { label: string; sortOrder?: number; segmentId?: string | null; actorUid: string }): Promise<CatalogItem> {
    if (input.segmentId !== undefined && input.segmentId !== null) await this.assertSegmentActive(input.segmentId);
    try {
      const row = await withActorContext(this.pool, async (cli) => {
        // `segment_id` só entra na coluna quando o CHAMADOR mandou a chave (schema por `kind` já
        // garante que só objetivos/atividades chegam aqui com ela) — ausente não toca a coluna,
        // mesmo Merge Patch do `update` abaixo, para não quebrar o molde de params do `create` de
        // `segments` nem dos testes que não passam `segmentId`.
        const cols = ['label', 'sort_order'];
        const params: unknown[] = [input.label, input.sortOrder ?? null];
        const placeholders = ['$1', `COALESCE($2, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM ${this.table(kind)}))`];
        if (input.segmentId !== undefined) {
          params.push(input.segmentId);
          cols.push('segment_id');
          placeholders.push(`$${params.length}`);
        }
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
      if (isLabelUnique(err)) throw new CatalogLabelTakenError();
      throw err;
    }
  }

  /** Merge Patch: chave ausente não toca a coluna. `active:false` carimba `deactivated_at`; `true` limpa. */
  async update(
    kind: TherapeuticCatalogKind,
    id: string,
    patch: { label?: string; sortOrder?: number; segmentId?: string | null; active?: boolean; actorUid: string },
  ): Promise<CatalogItem | null> {
    if (patch.segmentId !== undefined && patch.segmentId !== null) await this.assertSegmentActive(patch.segmentId);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.label !== undefined) push('label', patch.label);
    if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder);
    if (patch.segmentId !== undefined) push('segment_id', patch.segmentId);
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
      if (isLabelUnique(err)) throw new CatalogLabelTakenError();
      throw err;
    }
  }
}
