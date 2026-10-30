import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';

/**
 * Porta de banco das capabilities `agentes.*` (spec 078, M3a-2) sobre o schema `agentes` (migration 551).
 * INSERT-only no banco: aqui só há INSERT e SELECT. Toda operação roda em `withActorContext` (nunca
 * `pool.connect()` cru: o RLS recusaria sem identidade) com o ator `system:mcp:<principal>`.
 * Nenhum texto de conversa passa por aqui — só referências e campos curtos.
 */

export interface VeredictoInput {
  operador: string;
  sensor: string;
  inbox: string;
  conversa_ref: string;
  ultima_msg_ref: string;
  nota?: number;
  cruza_areas: boolean;
  juiz_versao?: string;
  avaliado_em: string;
  achados: Array<{ tipo: string; regra_ref: string; gravidade?: string }>;
}

export interface ReporteInput {
  autor: string;
  operador: string;
  area: string;
  caso: string;
  regra_ref?: string;
  ocorrencias?: number;
  janela_de: string;
  janela_ate: string;
  observacao: string;
  regra_proposta?: string;
  veredicto_ids: string[];
}

export interface PedidoInput {
  assunto: string;
  descricao: string;
  autor: string;
  area: string;
  grave_gatilho: string;
  registro_versao: string;
  atitude: {
    degrau: number;
    conteudo: string;
    caso_teste: string;
    metrica_alvo: string;
    janela: string;
    gatilho_rollback: string;
  };
  origens: Array<{ reporte_id: string } | { veredicto_id: string }>;
}

export interface MedicaoInput {
  metrica: string;
  escopo: string;
  de: string;
  ate: string;
  valor: number;
  n: number;
  medido_em: string;
  motivo: string;
  pedido_id?: string;
}

export interface PlacarResult {
  operador: string;
  de: string;
  ate: string;
  veredictos: number;
  conversas: number;
  nota_media: number | null;
  cruza_areas: number;
  por_regra: Array<{ regra_ref: string; violacoes: number; gravidade_max: string; veredicto_ids: string[] }>;
  veredicto_ids: string[];
}

const actorOf = (principal: string) => systemActor(`mcp:${principal}`);

export class AgentesRepository {
  constructor(private readonly pool: Pool) {}

  /** `duplicado: true` quando a UNIQUE (sensor, inbox, conversa, última msg) já tem o veredicto: nada é regravado. */
  async registrarVeredicto(
    principal: string,
    v: VeredictoInput,
  ): Promise<{ id: string; duplicado?: true }> {
    return withActorContext(
      this.pool,
      async (c) => {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO agentes.veredictos
             (operador, sensor, inbox, conversa_ref, ultima_msg_ref, nota, cruza_areas, juiz_versao, avaliado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT ON CONSTRAINT veredictos_uma_por_ultima_msg DO NOTHING
           RETURNING id`,
          [v.operador, v.sensor, v.inbox, v.conversa_ref, v.ultima_msg_ref, v.nota ?? null,
           v.cruza_areas, v.juiz_versao ?? null, v.avaliado_em],
        );
        if (ins.rows.length === 0) {
          const ex = await c.query<{ id: string }>(
            `SELECT id FROM agentes.veredictos
              WHERE sensor=$1 AND inbox=$2 AND conversa_ref=$3 AND ultima_msg_ref=$4`,
            [v.sensor, v.inbox, v.conversa_ref, v.ultima_msg_ref],
          );
          return { id: ex.rows[0].id, duplicado: true as const };
        }
        const id = ins.rows[0].id;
        for (const a of v.achados) {
          await c.query(
            `INSERT INTO agentes.veredicto_achados (veredicto_id, tipo, regra_ref, gravidade) VALUES ($1,$2,$3,$4)`,
            [id, a.tipo, a.regra_ref, a.gravidade ?? null],
          );
        }
        return { id };
      },
      actorOf(principal),
    );
  }

  /** `duplicado: true` quando (operador, caso, regra_ref, janela) já existe (índice `ux_reportes_dedup`): nada é regravado. */
  async registrarReporte(
    principal: string,
    r: ReporteInput,
  ): Promise<{ id: string; duplicado?: true }> {
    return withActorContext(
      this.pool,
      async (c) => {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO agentes.reportes
             (autor, operador, area, caso, regra_ref, ocorrencias, janela_de, janela_ate, observacao, regra_proposta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [r.autor, r.operador, r.area, r.caso, r.regra_ref ?? null, r.ocorrencias ?? null,
           r.janela_de, r.janela_ate, r.observacao, r.regra_proposta ?? null],
        );
        if (ins.rows.length === 0) {
          const ex = await c.query<{ id: string }>(
            `SELECT id FROM agentes.reportes
              WHERE operador=$1 AND caso=$2 AND COALESCE(regra_ref,'') = COALESCE($3::text,'')
                AND janela_de=$4 AND janela_ate=$5`,
            [r.operador, r.caso, r.regra_ref ?? null, r.janela_de, r.janela_ate],
          );
          return { id: ex.rows[0].id, duplicado: true as const };
        }
        const id = ins.rows[0].id;
        for (const vid of new Set(r.veredicto_ids)) {
          await c.query(
            `INSERT INTO agentes.reporte_veredictos (reporte_id, veredicto_id) VALUES ($1,$2)`,
            [id, vid],
          );
        }
        return { id };
      },
      actorOf(principal),
    );
  }

  async lerReportes(
    principal: string,
    f: { desde?: string; operador?: string },
  ): Promise<{ reportes: Array<Record<string, unknown>> }> {
    return withActorContext(
      this.pool,
      async (c) => {
        const { rows } = await c.query(
          `SELECT r.id, r.autor, r.operador, r.area, r.caso, r.regra_ref, r.ocorrencias,
                  to_char(r.janela_de, 'YYYY-MM-DD') AS janela_de, to_char(r.janela_ate, 'YYYY-MM-DD') AS janela_ate,
                  r.observacao, r.regra_proposta, r.criado_em,
                  COALESCE((SELECT array_agg(rv.veredicto_id ORDER BY rv.veredicto_id)
                              FROM agentes.reporte_veredictos rv WHERE rv.reporte_id = r.id), '{}') AS veredicto_ids,
                  COALESCE((SELECT array_agg(DISTINCT po.pedido_id ORDER BY po.pedido_id)
                              FROM agentes.pedido_origens po WHERE po.reporte_id = r.id), '{}') AS pedido_ids
             FROM agentes.reportes r
            WHERE ($1::timestamptz IS NULL OR r.criado_em >= $1)
              AND ($2::text IS NULL OR r.operador = $2)
            ORDER BY r.criado_em DESC, r.id
            LIMIT 200`,
          [f.desde ?? null, f.operador ?? null],
        );
        return { reportes: rows };
      },
      actorOf(principal),
    );
  }

  /** Agregados do placar de um operador na janela [de, ate). Sem texto: só contagens, gravidade e ids. */
  async lerPlacar(
    principal: string,
    p: { operador: string; de: string; ate: string },
  ): Promise<PlacarResult> {
    return withActorContext(
      this.pool,
      async (c) => {
        const base = await c.query<{
          veredictos: string; conversas: string; nota_media: string | null; cruza: string; ids: string[];
        }>(
          `SELECT count(*) AS veredictos,
                  count(DISTINCT (inbox, conversa_ref)) AS conversas,
                  avg(nota)::float8 AS nota_media,
                  count(*) FILTER (WHERE cruza_areas) AS cruza,
                  COALESCE(array_agg(id ORDER BY avaliado_em, id), '{}') AS ids
             FROM agentes.veredictos
            WHERE operador = $1 AND avaliado_em >= $2 AND avaliado_em < $3`,
          [p.operador, p.de, p.ate],
        );
        const regras = await c.query<{
          regra_ref: string; violacoes: string; gravidade_max: string; veredicto_ids: string[];
        }>(
          `SELECT a.regra_ref,
                  count(*) AS violacoes,
                  CASE max(CASE a.gravidade WHEN 'alta' THEN 3 WHEN 'media' THEN 2 ELSE 1 END)
                    WHEN 3 THEN 'alta' WHEN 2 THEN 'media' ELSE 'baixa' END AS gravidade_max,
                  array_agg(DISTINCT a.veredicto_id ORDER BY a.veredicto_id) AS veredicto_ids
             FROM agentes.veredicto_achados a
             JOIN agentes.veredictos v ON v.id = a.veredicto_id
            WHERE a.tipo = 'violacao' AND v.operador = $1 AND v.avaliado_em >= $2 AND v.avaliado_em < $3
            GROUP BY a.regra_ref
            ORDER BY count(*) DESC, a.regra_ref`,
          [p.operador, p.de, p.ate],
        );
        const b = base.rows[0];
        return {
          operador: p.operador,
          de: p.de,
          ate: p.ate,
          veredictos: Number(b.veredictos),
          conversas: Number(b.conversas),
          nota_media: b.nota_media === null ? null : Number(b.nota_media),
          cruza_areas: Number(b.cruza),
          por_regra: regras.rows.map((r) => ({
            regra_ref: r.regra_ref,
            violacoes: Number(r.violacoes),
            gravidade_max: r.gravidade_max,
            veredicto_ids: r.veredicto_ids,
          })),
          veredicto_ids: b.ids,
        };
      },
      actorOf(principal),
    );
  }

  /** pedido + atitude (versão 1) + origens numa transação só; status inicial 'novo' vem da view, não de coluna. */
  async depositarPedido(
    principal: string,
    p: PedidoInput,
  ): Promise<{ pedido_id: string; atitude_id: string }> {
    return withActorContext(
      this.pool,
      async (c) => {
        const ped = await c.query<{ id: string }>(
          `INSERT INTO agentes.pedidos (assunto, descricao, autor, area, grave_gatilho, registro_versao)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [p.assunto, p.descricao, p.autor, p.area, p.grave_gatilho, p.registro_versao],
        );
        const pedidoId = ped.rows[0].id;
        const at = await c.query<{ id: string }>(
          `INSERT INTO agentes.pedido_atitudes
             (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [pedidoId, p.atitude.degrau, p.atitude.conteudo, p.atitude.caso_teste,
           p.atitude.metrica_alvo, p.atitude.janela, p.atitude.gatilho_rollback],
        );
        for (const o of p.origens) {
          await c.query(
            `INSERT INTO agentes.pedido_origens (pedido_id, reporte_id, veredicto_id) VALUES ($1,$2,$3)`,
            [pedidoId, 'reporte_id' in o ? o.reporte_id : null, 'veredicto_id' in o ? o.veredicto_id : null],
          );
        }
        return { pedido_id: pedidoId, atitude_id: at.rows[0].id };
      },
      actorOf(principal),
    );
  }

  /** Foto datada de um número que muda (linha de base, antes/depois de um pedido). Os CHECKs da tabela são a trava. */
  async registrarMedicao(principal: string, m: MedicaoInput): Promise<{ id: string }> {
    return withActorContext(
      this.pool,
      async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO agentes.medicoes (metrica, escopo, de, ate, valor, n, medido_em, motivo, pedido_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [m.metrica, m.escopo, m.de, m.ate, m.valor, m.n, m.medido_em, m.motivo, m.pedido_id ?? null],
        );
        return { id: rows[0].id };
      },
      actorOf(principal),
    );
  }
}
