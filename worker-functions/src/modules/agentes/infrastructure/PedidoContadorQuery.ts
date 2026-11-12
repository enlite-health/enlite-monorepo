import type { Pool, PoolClient } from 'pg';

/**
 * Os DOIS contadores de "aceita sem contestar" da página Pedidos (D601, spec 081 F4). Consulta SÓ-LEITURA e
 * DERIVADA (D514/D516): nenhuma coluna nova, nada gravado. Quem chama abre o `withActorContext` (a RLS exige `app.user_uid`).
 *
 * - Contador 1: pedido com ao menos uma origem `reporte_id` (origem mista conta aqui). Régua: 4 semanas válidas seguidas.
 * - Contador 2: pedido cuja ÚNICA origem é `veredicto_id`. Régua: 26 semanas válidas seguidas.
 * - Classe do pedido pelo PRIMEIRO evento (todo evento é humano, por CHECK no banco):
 *     limpa      = `aceitar`, comentario NULL, atitude versao = 1 (como é o primeiro evento, não há `descrever` antes);
 *     contestacao = qualquer outro primeiro evento (negar, descrever, aceitar com comentário ou em versão > 1);
 *     pendente   = sem evento (não conta nem zera).
 * - Semana (America/Argentina/Buenos_Aires, segunda a domingo) pela `criado_em` do pedido:
 *     com contestação -> ZERA a sequência (mesmo que haja >= 2 limpas na semana);
 *     sem contestação e >= SEMANA_VALIDA_MIN_LIMPAS limpas -> VÁLIDA (+1);
 *     demais (1 limpa só, só pendentes) -> neutra: não avança nem zera. Semana sem proposta nem aparece.
 * A definição de semana é INTERPRETAÇÃO do orquestrador (D601), reversível: por isso as constantes abaixo.
 */
export const REGUA_CONTADOR_1_SEMANAS = 4;
export const REGUA_CONTADOR_2_SEMANAS = 26;
export const SEMANA_VALIDA_MIN_LIMPAS = 2;
const FUSO = 'America/Argentina/Buenos_Aires';

export type ClassePedido = 'limpa' | 'contestacao' | 'pendente';
export type DbLeitura = Pick<Pool | PoolClient, 'query'>;

export interface ContadorPedidos {
  /** Sequência vigente ao fim da janela (semanas neutras não quebram nem somam). */
  semanasValidasSeguidas: number;
  reguaSemanas: number;
  atingiuRegua: boolean;
  /** Segunda-feira (YYYY-MM-DD) da semana da última contestação, ou null. */
  ultimaContestacaoSemana: string | null;
  pendentes: number;
  pedidos: number;
}
export interface ContadoresPedidos { contador1: ContadorPedidos; contador2: ContadorPedidos }

interface Linha { contador: number; semana: string; classe: ClassePedido }
export interface SemanaAgregada { semana: string; limpas: number; contestacoes: number }

/** Pura: sequência vigente a partir das semanas (qualquer ordem de entrada). */
export function sequenciaVigente(semanas: SemanaAgregada[]): { seguidas: number; ultimaContestacao: string | null } {
  let seguidas = 0;
  let ultima: string | null = null;
  for (const s of [...semanas].sort((a, b) => (a.semana < b.semana ? -1 : 1))) {
    if (s.contestacoes > 0) { seguidas = 0; ultima = s.semana; }
    else if (s.limpas >= SEMANA_VALIDA_MIN_LIMPAS) seguidas += 1;
  }
  return { seguidas, ultimaContestacao: ultima };
}

function montar(linhas: Linha[], regua: number): ContadorPedidos {
  const porSemana = new Map<string, SemanaAgregada>();
  let pendentes = 0;
  for (const l of linhas) {
    const s = porSemana.get(l.semana) ?? { semana: l.semana, limpas: 0, contestacoes: 0 };
    if (l.classe === 'limpa') s.limpas += 1;
    else if (l.classe === 'contestacao') s.contestacoes += 1;
    else pendentes += 1;
    porSemana.set(l.semana, s);
  }
  const { seguidas, ultimaContestacao } = sequenciaVigente([...porSemana.values()]);
  return {
    semanasValidasSeguidas: seguidas,
    reguaSemanas: regua,
    atingiuRegua: seguidas >= regua,
    ultimaContestacaoSemana: ultimaContestacao,
    pendentes,
    pedidos: linhas.length,
  };
}

/** Janela: pedidos com `criado_em` em [de, ate). */
export async function consultarContadoresPedidos(db: DbLeitura, janela: { de: Date; ate: Date }): Promise<ContadoresPedidos> {
  const { rows } = await db.query<Linha>(
    `WITH primeiro AS (
       SELECT DISTINCT ON (e.pedido_id) e.pedido_id, e.acao, e.comentario, a.versao
         FROM agentes.pedido_eventos e
         JOIN agentes.pedido_atitudes a ON a.id = e.atitude_id
        ORDER BY e.pedido_id, e.ts, e.id
     ), origem AS (
       SELECT o.pedido_id,
              bool_or(o.reporte_id IS NOT NULL)   AS tem_reporte,
              bool_or(o.veredicto_id IS NOT NULL) AS tem_veredicto
         FROM agentes.pedido_origens o
        GROUP BY o.pedido_id
     )
     SELECT CASE WHEN og.tem_reporte THEN 1 ELSE 2 END AS contador,
            to_char(date_trunc('week', p.criado_em AT TIME ZONE $3), 'YYYY-MM-DD') AS semana,
            CASE WHEN pr.pedido_id IS NULL THEN 'pendente'
                 WHEN pr.acao = 'aceitar' AND pr.comentario IS NULL AND pr.versao = 1 THEN 'limpa'
                 ELSE 'contestacao' END AS classe
       FROM agentes.pedidos p
       JOIN origem og ON og.pedido_id = p.id
       LEFT JOIN primeiro pr ON pr.pedido_id = p.id
      WHERE p.criado_em >= $1 AND p.criado_em < $2
        AND (og.tem_reporte OR og.tem_veredicto)`,
    [janela.de.toISOString(), janela.ate.toISOString(), FUSO],
  );
  return {
    contador1: montar(rows.filter((r) => Number(r.contador) === 1), REGUA_CONTADOR_1_SEMANAS),
    contador2: montar(rows.filter((r) => Number(r.contador) === 2), REGUA_CONTADOR_2_SEMANAS),
  };
}
