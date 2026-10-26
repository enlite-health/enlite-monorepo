import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import {
  ShiftTemplateItemsOverlapError,
  type ShiftTemplate,
  type ShiftTemplateItem,
} from '../domain/serviceShiftTemplate';
import { CatalogLabelTakenError } from './TherapeuticCatalogRepository';

interface TemplateRow {
  id: string;
  code: string;
  label: string;
  active: boolean;
  items: ShiftTemplateItem[];
}

const isLabelUnique = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
  && /_label_ativo/.test(String((err as { constraint?: string }).constraint ?? ''));

const isOverlap = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23P01'
  && (err as { constraint?: string }).constraint === 'ssti_sem_sobreposicao';

/** Erros do banco viram erros nomeados; a transação já deu ROLLBACK em `withActorContext`. */
const translate = (err: unknown): never => {
  if (isLabelUnique(err)) throw new CatalogLabelTakenError();
  if (isOverlap(err)) throw new ShiftTemplateItemsOverlapError();
  throw err;
};

const SELECT_WITH_ITEMS = `
  SELECT t.id, t.code, t.label, t.active,
         COALESCE((SELECT json_agg(json_build_object('startTime', to_char(i.start_time, 'HH24:MI'),
                                                     'durationMinutes', i.duration_minutes)
                                   ORDER BY i.start_time)
                     FROM service_shift_template_items i WHERE i.template_id = t.id), '[]'::json) AS items
    FROM service_shift_templates t`;

const toTemplate = (r: TemplateRow): ShiftTemplate => ({
  id: r.id, code: r.code, label: r.label, active: r.active, items: r.items,
});

async function insertItems(cli: PoolClient, templateId: string, items: ShiftTemplateItem[]): Promise<void> {
  for (const it of items) {
    await cli.query(
      `INSERT INTO service_shift_template_items (template_id, start_time, duration_minutes) VALUES ($1, $2::time, $3)`,
      [templateId, it.startTime, it.durationMinutes],
    );
  }
}

async function readOne(cli: PoolClient, id: string): Promise<ShiftTemplate> {
  const res = await cli.query<TemplateRow>(`${SELECT_WITH_ITEMS} WHERE t.id = $1`, [id]);
  return toTemplate(res.rows[0]);
}

/**
 * Guardias predefinidas (migration 550, spec 074): catálogo global, sem país. Baixa é `active=false`
 * + `deactivated_at`, nunca DELETE. Escritas numa transação só (guardia + itens); a sobreposição
 * dentro da guardia é barrada pelo banco e traduzida aqui.
 */
export class ServiceShiftTemplateRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async list(opts: { includeInactive?: boolean } = {}): Promise<ShiftTemplate[]> {
    const where = opts.includeInactive ? '' : 'WHERE t.active';
    const res = await this.pool.query<TemplateRow>(`${SELECT_WITH_ITEMS} ${where} ORDER BY lower(t.label)`);
    return res.rows.map(toTemplate);
  }

  async create(input: { label: string; items: ShiftTemplateItem[]; actorUid: string }): Promise<ShiftTemplate> {
    try {
      return await withActorContext(this.pool, async (cli) => {
        // Sem `code`: o trigger da 550 preenche com o id.
        const ins = await cli.query<{ id: string }>(
          `INSERT INTO service_shift_templates (label, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
          [input.label, input.actorUid],
        );
        await insertItems(cli, ins.rows[0].id, input.items);
        return readOne(cli, ins.rows[0].id);
      });
    } catch (err) {
      return translate(err);
    }
  }

  /** Merge Patch: chave ausente não toca a coluna; `items` presente SUBSTITUI os turnos. Id inexistente → `null`. */
  async update(
    id: string,
    patch: { label?: string; active?: boolean; items?: ShiftTemplateItem[]; actorUid: string },
  ): Promise<ShiftTemplate | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.label !== undefined) push('label', patch.label);
    if (patch.active !== undefined) {
      push('active', patch.active);
      sets.push(patch.active ? 'deactivated_at = NULL' : 'deactivated_at = NOW()');
    }
    push('updated_by', patch.actorUid);
    sets.push('updated_at = NOW()');
    try {
      return await withActorContext(this.pool, async (cli) => {
        const upd = await cli.query(
          `UPDATE service_shift_templates SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
          params,
        );
        if (upd.rows.length === 0) return null;
        if (patch.items !== undefined) {
          await cli.query(`DELETE FROM service_shift_template_items WHERE template_id = $1`, [id]);
          await insertItems(cli, id, patch.items);
        }
        return readOne(cli, id);
      });
    } catch (err) {
      return translate(err);
    }
  }
}
