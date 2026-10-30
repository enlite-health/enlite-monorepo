import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { staffActor } from '@shared/audit/actorSource';
import {
  DecisaoJaRegistradaError,
  PedidoNaoEncontradoError,
  type DecisaoInput,
  type FiltroPedidos,
  type PedidoIa,
  type PedidoStatus,
} from '../domain/PedidoIa';
import type { PedidoIaRepositoryPort } from '../domain/PedidoIaRepositoryPort';

/**
 * Pedidos do schema `agentes` (migration 551). INSERT-only no banco: aqui só há SELECT e INSERT em `pedido_eventos`.
 * Tudo em `withActorContext` (a RLS exige `app.user_uid`; `connect()` cru dá 500/zero linhas).
 */
const SELECT_PEDIDOS = `
  SELECT p.id, p.assunto, p.autor, p.area, p.grave_gatilho, s.status,
         p.criado_em, floor(extract(epoch FROM (now() - p.criado_em)) / 3600)::int AS idade_h,
         (SELECT to_jsonb(a) FROM (
            SELECT versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback
              FROM agentes.pedido_atitudes WHERE pedido_id = p.id ORDER BY versao DESC LIMIT 1) a) AS atitude_atual,
         COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                     'acao', e.acao, 'actor_uid', e.actor_uid, 'actor_kind', e.actor_kind, 'ts', e.ts,
                     'motivo', e.motivo, 'comentario', e.comentario)) ORDER BY e.ts, e.id)
                     FROM agentes.pedido_eventos e WHERE e.pedido_id = p.id), '[]'::jsonb) AS eventos
    FROM agentes.pedidos p
    JOIN agentes.pedido_status s ON s.pedido_id = p.id`;

interface Row extends Omit<PedidoIa, 'criado_em'> { criado_em: Date }

const toPedido = (r: Row): PedidoIa => ({ ...r, criado_em: new Date(r.criado_em).toISOString() });

export class PostgresPedidoIaRepository implements PedidoIaRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async listar(f: FiltroPedidos): Promise<PedidoIa[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.area !== undefined) { params.push(f.area); where.push(`p.area = $${params.length}`); }
    if (f.status !== undefined) { params.push(f.status); where.push(`s.status = $${params.length}`); }
    if (f.grave !== undefined) where.push(f.grave ? `p.grave_gatilho <> 'nenhum'` : `p.grave_gatilho = 'nenhum'`);
    const sql = `${SELECT_PEDIDOS}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY p.criado_em DESC, p.id`;
    return withActorContext(this.pool, async (c) => (await c.query<Row>(sql, params)).rows.map(toPedido));
  }

  async obter(id: string): Promise<PedidoIa | null> {
    return withActorContext(this.pool, async (c) => {
      const r = await c.query<Row>(`${SELECT_PEDIDOS} WHERE p.id = $1`, [id]);
      return r.rows[0] ? toPedido(r.rows[0]) : null;
    });
  }

  async decidir(i: DecisaoInput): Promise<{ evento_id: string; status: PedidoStatus }> {
    try {
      return await withActorContext(
        this.pool,
        async (c) => {
          const at = await c.query<{ id: string }>(
            `SELECT id FROM agentes.pedido_atitudes WHERE pedido_id = $1 ORDER BY versao DESC LIMIT 1`,
            [i.pedidoId],
          );
          if (!at.rows[0]) throw new PedidoNaoEncontradoError();
          const ev = await c.query<{ id: string }>(
            `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo, comentario)
             VALUES ($1, $2, $3, $4, 'humano', $5, $6) RETURNING id`,
            [i.pedidoId, at.rows[0].id, i.acao, i.actorUid, i.motivo ?? null, i.comentario ?? null],
          );
          const st = await c.query<{ status: PedidoStatus }>(
            `SELECT status FROM agentes.pedido_status WHERE pedido_id = $1`,
            [i.pedidoId],
          );
          return { evento_id: ev.rows[0].id, status: st.rows[0].status };
        },
        staffActor(i.actorUid),
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new DecisaoJaRegistradaError();
      throw err;
    }
  }
}
