import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { COUNTRY_CODES } from '@shared/domain/countryCodes';
import { funnelLegadoQuery, workerCadastrosQuery } from '../../matching/application/managementDashboardQueries';

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
  /** Lista fechada do GRAVE (item 53): um item por violação de gatilho. Só refs, nenhum texto. */
  graves: Array<{
    veredicto_id: string; sensor: string; inbox: string; conversa_ref: string; ultima_msg_ref: string;
    regra_ref: string; gatilho: 'nunca' | 'dado' | 'acao_fabricada'; avaliado_em: string;
  }>;
}

export interface AprovacaoVerificada {
  valida: boolean;
  acao: 'aceitar' | 'negar' | 'descrever' | null;
  pedido_id: string | null;
  atitude_id: string | null;
  atitude_versao: number | null;
  atitude_atual: boolean;
  decidido_em: string | null;
  /** Comentário do humano que aprovou (aprovar com comentário); `null` se aprovou sem comentário ou o evento não existe. */
  comentario: string | null;
}

const actorOf = (principal: string) => systemActor(`mcp:${principal}`);

/** O que o depósito pede ao aviso (M3b-2): in-app dentro da transação, WhatsApp depois do commit. Só o ID — nenhum texto do pedido. */
export interface AvisoDoDeposito {
  naTransacao(c: PoolClient, i: { pedidoId: string; grave: boolean }): Promise<unknown>;
  whatsappGrave(pedidoId: string): Promise<void>;
}

export interface IndicadoresResult {
  de: string;
  ate: string;
  cadastros_completos: { total: number; no_periodo: number };
  vagas_selecionadas: { no_periodo: number };
  fonte: 'analytics.management_dashboard';
}

/**
 * Spec 080: the arguments and results of the two extracted functions below are in English (glossary §3/§6.4);
 * the SQL inside keeps the legacy `agentes.*` columns and values. `escalationFromLegacy` / `escalationResultToLegacy`
 * are the edge between the legacy body (`ReporteInput`, `{id, duplicado}`) and these arguments.
 */
export type EscalationKind = 'LIGHT' | 'META' | 'REINFORCEMENT';

export interface EscalationInput {
  author: string;
  operator: string;
  area: string;
  kind: EscalationKind;
  rule_ref?: string;
  occurrences?: number;
  window_from: string;
  window_to: string;
  note: string;
  proposed_rule?: string;
  verdict_ids: string[];
}

const KIND_TO_CASO: Readonly<Record<EscalationKind, string>> = { LIGHT: 'leve', META: 'meta', REINFORCEMENT: 'reforco' };
const CASO_TO_KIND: Readonly<Record<string, EscalationKind>> = { leve: 'LIGHT', meta: 'META', reforco: 'REINFORCEMENT' };

/** Legacy body (`caso` leve/meta/reforco, `gestora`-side fields) -> English arguments. An unknown `caso` is rejected. */
export function escalationFromLegacy(r: ReporteInput): EscalationInput {
  const kind = CASO_TO_KIND[r.caso];
  if (!kind) throw new Error(`unknown caso: ${r.caso}`);
  return {
    author: r.autor,
    operator: r.operador,
    area: r.area,
    kind,
    rule_ref: r.regra_ref,
    occurrences: r.ocorrencias,
    window_from: r.janela_de,
    window_to: r.janela_ate,
    note: r.observacao,
    proposed_rule: r.regra_proposta,
    verdict_ids: r.veredicto_ids,
  };
}

/** `{id, duplicate}` -> the legacy `{id, duplicado}` that the callers on the legacy side keep seeing. */
export function escalationResultToLegacy(o: { id: string; duplicate?: true }): { id: string; duplicado?: true } {
  return o.duplicate ? { id: o.id, duplicado: true as const } : { id: o.id };
}

/** Shared body (spec 080 T022): the SAME SQL runs under the MCP actor (repository) and on behalf of the person (the Maria tools). */
export async function registerEscalationWith(c: PoolClient, e: EscalationInput): Promise<{ id: string; duplicate?: true }> {
    const caso = KIND_TO_CASO[e.kind];
    const ins = await c.query<{ id: string }>(
      `INSERT INTO agentes.reportes
         (autor, operador, area, caso, regra_ref, ocorrencias, janela_de, janela_ate, observacao, regra_proposta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [e.author, e.operator, e.area, caso, e.rule_ref ?? null, e.occurrences ?? null,
       e.window_from, e.window_to, e.note, e.proposed_rule ?? null],
    );
    if (ins.rows.length === 0) {
      const ex = await c.query<{ id: string }>(
        `SELECT id FROM agentes.reportes
          WHERE operador=$1 AND caso=$2 AND COALESCE(regra_ref,'') = COALESCE($3::text,'')
            AND janela_de=$4 AND janela_ate=$5`,
        [e.operator, caso, e.rule_ref ?? null, e.window_from, e.window_to],
      );
      return { id: ex.rows[0].id, duplicate: true as const };
    }
    const id = ins.rows[0].id;
    for (const vid of new Set(e.verdict_ids)) {
      await c.query(
        `INSERT INTO agentes.reporte_veredictos (reporte_id, veredicto_id) VALUES ($1,$2)`,
        [id, vid],
      );
    }
    return { id };
}

/** Shared body (spec 080 T022): the SAME SQL runs under the MCP actor (repository) and on behalf of the person (the Maria tools). */
export async function readScoreboardWith(c: PoolClient, p: { operator: string; from: string; to: string; never_refs?: string[] }): Promise<PlacarResult> {
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
      [p.operator, p.from, p.to],
    );
    const rules = await c.query<{
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
      [p.operator, p.from, p.to],
    );
    // SEVERE (item 53): only 3 triggers. Scrubber -> data; notary -> fabricated action; rule in never_refs -> never.
    // The judge's 'alta' severity, alone, does NOT count. CASE order = precedence when more than one matches.
    const severe = await c.query<{
      veredicto_id: string; sensor: string; inbox: string; conversa_ref: string; ultima_msg_ref: string;
      regra_ref: string; gatilho: 'nunca' | 'dado' | 'acao_fabricada'; avaliado_em: Date;
    }>(
      `SELECT * FROM (
         SELECT v.id AS veredicto_id, v.sensor, v.inbox, v.conversa_ref, v.ultima_msg_ref, a.regra_ref, v.avaliado_em,
                CASE WHEN v.sensor = 'scrubber' THEN 'dado'
                     WHEN v.sensor = 'notario'  THEN 'acao_fabricada'
                     WHEN a.regra_ref = ANY($4::text[]) THEN 'nunca' END AS gatilho
           FROM agentes.veredicto_achados a
           JOIN agentes.veredictos v ON v.id = a.veredicto_id
          WHERE a.tipo = 'violacao' AND v.operador = $1 AND v.avaliado_em >= $2 AND v.avaliado_em < $3) g
        WHERE gatilho IS NOT NULL
        ORDER BY avaliado_em, veredicto_id, regra_ref`,
      [p.operator, p.from, p.to, p.never_refs ?? []],
    );
    const b = base.rows[0];
    return {
      operador: p.operator,
      de: p.from,
      ate: p.to,
      veredictos: Number(b.veredictos),
      conversas: Number(b.conversas),
      nota_media: b.nota_media === null ? null : Number(b.nota_media),
      cruza_areas: Number(b.cruza),
      por_regra: rules.rows.map((r) => ({
        regra_ref: r.regra_ref,
        violacoes: Number(r.violacoes),
        gravidade_max: r.gravidade_max,
        veredicto_ids: r.veredicto_ids,
      })),
      veredicto_ids: b.ids,
      graves: severe.rows.map((g) => ({ ...g, avaliado_em: new Date(g.avaliado_em).toISOString() })),
    };
}

export class AgentesRepository {
  constructor(private readonly pool: Pool, private readonly avisos?: AvisoDoDeposito) {}

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
    return withActorContext(this.pool, async (c) => escalationResultToLegacy(await registerEscalationWith(c, escalationFromLegacy(r))), actorOf(principal));
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
    p: { operador: string; de: string; ate: string; nunca_refs?: string[] },
  ): Promise<PlacarResult> {
    return withActorContext(this.pool, (c) => readScoreboardWith(c, { operator: p.operador, from: p.de, to: p.ate, never_refs: p.nunca_refs }), actorOf(principal));
  }

  /** pedido + atitude (versão 1) + origens numa transação só; status inicial 'novo' vem da view, não de coluna. */
  async depositarPedido(
    principal: string,
    p: PedidoInput,
  ): Promise<{ pedido_id: string; atitude_id: string }> {
    const grave = p.grave_gatilho !== 'nenhum';
    const r = await withActorContext(
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
        await this.avisos?.naTransacao(c, { pedidoId, grave });
        return { pedido_id: pedidoId, atitude_id: at.rows[0].id };
      },
      actorOf(principal),
    );
    // Depois do commit: o WhatsApp de um pedido que não existiu seria pior que nenhum. Falha dele nunca desfaz o pedido.
    if (grave) await this.avisos?.whatsappGrave(r.pedido_id);
    return r;
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

  /** Id de aprovação = `id` do evento. Só leitura; inexistente => `valida=false, acao=null`. */
  async verificarAprovacao(principal: string, aprovacaoId: string): Promise<AprovacaoVerificada> {
    return withActorContext(
      this.pool,
      async (c) => {
        const { rows } = await c.query<{
          acao: AprovacaoVerificada['acao']; pedido_id: string; atitude_id: string; atitude_versao: number;
          atitude_atual: boolean; ts: Date; comentario: string | null;
        }>(
          `SELECT e.acao, e.pedido_id, e.atitude_id, a.versao AS atitude_versao, e.ts, e.comentario,
                  a.versao = (SELECT max(x.versao) FROM agentes.pedido_atitudes x WHERE x.pedido_id = e.pedido_id) AS atitude_atual
             FROM agentes.pedido_eventos e
             JOIN agentes.pedido_atitudes a ON a.id = e.atitude_id AND a.pedido_id = e.pedido_id
            WHERE e.id = $1`,
          [aprovacaoId],
        );
        if (rows.length === 0) {
          return { valida: false, acao: null, pedido_id: null, atitude_id: null, atitude_versao: null, atitude_atual: false, decidido_em: null, comentario: null };
        }
        const r = rows[0];
        return {
          valida: r.acao === 'aceitar' && r.atitude_atual,
          acao: r.acao,
          pedido_id: r.pedido_id,
          atitude_id: r.atitude_id,
          atitude_versao: Number(r.atitude_versao),
          atitude_atual: r.atitude_atual,
          decidido_em: new Date(r.ts).toISOString(),
          comentario: r.comentario ?? null,
        };
      },
      actorOf(principal),
    );
  }

  /**
   * Linha de base (item 41): as MESMAS queries do painel de gestão (`workerCadastrosQuery`, `funnelLegadoQuery`),
   * recortadas em `[de, ate)`. Só contagens. Países = todos (o painel sem `?country=`).
   */
  async lerIndicadores(principal: string, p: { de: string; ate: string }): Promise<IndicadoresResult> {
    return withActorContext(
      this.pool,
      async (c) => {
        const periodo = { de: p.de, ate: p.ate };
        const countries = [...COUNTRY_CODES];
        const [workers, funil] = await Promise.all([
          workerCadastrosQuery(c, countries, periodo),
          funnelLegadoQuery(c, countries, periodo),
        ]);
        const w = workers.rows[0] ?? { completos: 0, nuevos: 0 };
        return {
          de: p.de,
          ate: p.ate,
          cadastros_completos: { total: Number(w.completos), no_periodo: Number(w.nuevos) },
          vagas_selecionadas: { no_periodo: Number(funil.rows.find((r) => r.k === 'SELECTED')?.count ?? 0) },
          fonte: 'analytics.management_dashboard' as const,
        };
      },
      actorOf(principal),
    );
  }
}
