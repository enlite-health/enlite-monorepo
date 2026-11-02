/**
 * pedidos-ia-contador-seed.ts — massa SINTÉTICA dos dois contadores de "aceita sem contestar" (spec 081 F4, T098, D601).
 *
 * Mesmo caminho legítimo do irmão `pedidos-ia-seed.ts` (SQL como `enlite_admin` via `sqlViaDocker`; não existe rota que crie pedido).
 * As datas são RELATIVAS a `now()` (semana segunda-domingo em Buenos Aires, no meio da semana: 3ª-feira 12h BA), sempre em
 * semanas JÁ FECHADAS (>= 4 atrás) e dentro da janela padrão de 28 semanas — exceto o pedido FORA (30 semanas atrás).
 * Todo registro leva a marca da rodada (`area` do pedido, `regra_ref` do reporte, `conversa_ref` do veredicto): a limpeza só apaga o seu.
 * Nada clínico: textos óbvios de teste.
 */
import { limparPedidos, type RunSql } from './pedidos-ia-seed';

const BA = 'America/Argentina/Buenos_Aires';
const ATOR = 'humano-sintetico-contador';

export type Origem = 'reporte' | 'mista' | 'veredicto';
export type Evento = { acao: 'aceitar' } | { acao: 'negar'; motivo: string } | { acao: 'descrever'; comentario: string } | null;
export interface PedidoContador { id: string; semanasAtras: number; origem: Origem; ev: Evento }

/**
 * TABELA DA MASSA (semana = quantas semanas antes da semana corrente) e números esperados.
 *
 * pedido | semana | origem                  | 1º evento                  | classe      | conta em
 * -------|--------|-------------------------|----------------------------|-------------|------------------------
 * A0     |   -8   | reporte                 | negar (com motivo)         | contestação | contador 1 (ZERA)
 * A1     |   -6   | reporte                 | aceitar, sem comentário    | limpa       | contador 1
 * A2     |   -6   | MISTA reporte+veredicto | aceitar, sem comentário    | limpa       | contador 1 (mista conta no 1)
 * A3     |   -5   | reporte                 | aceitar, sem comentário    | limpa       | contador 1
 * A4     |   -5   | reporte                 | aceitar, sem comentário    | limpa       | contador 1
 * A5     |   -4   | reporte                 | aceitar, sem comentário    | limpa       | contador 1 (1 limpa só: semana neutra)
 * A6     |   -4   | reporte                 | (nenhum)                   | pendente    | contador 1 (não conta nem zera)
 * B1     |   -6   | só veredicto            | aceitar, sem comentário    | limpa       | contador 2
 * B2     |   -6   | só veredicto            | aceitar, sem comentário    | limpa       | contador 2
 * B3     |   -5   | só veredicto            | aceitar, sem comentário    | limpa       | contador 2 (1 limpa só: neutra)
 * FORA   |  -30   | só veredicto            | descrever (contestação)    | contestação | NENHUM (fora das 28 semanas; se entrasse, zerava o 2)
 *
 * Contador 1: -8 zera (última contestação = segunda da semana -8) · -6 válida (1) · -5 válida (2) · -4 neutra -> 2 de 4, pendentes 1, pedidos 7.
 * Contador 2: -6 válida (1) · -5 neutra -> 1 de 26, sem contestação, pendentes 0, pedidos 3.
 */
export const MASSA: PedidoContador[] = [
  { id: 'A0', semanasAtras: 8, origem: 'reporte', ev: { acao: 'negar', motivo: 'motivo sintetico' } },
  { id: 'A1', semanasAtras: 6, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'A2', semanasAtras: 6, origem: 'mista', ev: { acao: 'aceitar' } },
  { id: 'A3', semanasAtras: 5, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'A4', semanasAtras: 5, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'A5', semanasAtras: 4, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'A6', semanasAtras: 4, origem: 'reporte', ev: null },
  { id: 'B1', semanasAtras: 6, origem: 'veredicto', ev: { acao: 'aceitar' } },
  { id: 'B2', semanasAtras: 6, origem: 'veredicto', ev: { acao: 'aceitar' } },
  { id: 'B3', semanasAtras: 5, origem: 'veredicto', ev: { acao: 'aceitar' } },
  { id: 'FORA', semanasAtras: 30, origem: 'veredicto', ev: { acao: 'descrever', comentario: 'ajuste sintetico' } },
];

export const ESPERADO = {
  c1: { semanas: '2', regua: '2 de 4 semanas seguidas', pedidos: 'Pedidos: 7', pendentes: 'Pendientes: 1', ultimaSemanasAtras: 8 },
  c2: { semanas: '1', regua: '1 de 26 semanas seguidas', pedidos: 'Pedidos: 3', pendentes: 'Pendientes: 0', ultima: 'Sin contestaciones' },
} as const;

/** Segunda-feira (YYYY-MM-DD) da semana de Buenos Aires `n` semanas atrás — calculada em JS (BA = UTC-3, sem horário de verão). */
export function segundaBA(semanasAtras: number): string {
  const ba = new Date(Date.now() - 3 * 3600 * 1000);
  const dow = (ba.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ba.getUTCFullYear(), ba.getUTCMonth(), ba.getUTCDate() - dow - 7 * semanasAtras)).toISOString().slice(0, 10);
}

const quando = (n: number): string =>
  `((date_trunc('week', now() AT TIME ZONE '${BA}') - interval '${n} weeks' + interval '2 days 12 hours') AT TIME ZONE '${BA}')`;

/** 1 pedido (+ atitude v1, origens e 1º evento humano) por INSERT com CTEs; `tag` = marca da rodada (também é a área). */
function seedUm(run: RunSql, tag: string, p: PedidoContador): string {
  const ts = quando(p.semanasAtras);
  const ctes = [
    `p AS (INSERT INTO agentes.pedidos (assunto, descricao, autor, area, grave_gatilho, registro_versao, criado_em)
           VALUES ('Contador ${p.id} ${tag}', 'descricao sintetica', 'sol', '${tag}', 'nenhum', 'r1', ${ts}) RETURNING id)`,
    `a AS (INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
           SELECT id, 1, 1, 'conteudo sintetico', 'caso sintetico', 'metrica sintetica', '7d', 'rollback sintetico' FROM p RETURNING id)`,
  ];
  if (p.origem !== 'veredicto') {
    ctes.push(
      `r AS (INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao)
             VALUES ('autor-sintetico', 'operador-sintetico', 'area-sintetica', 'leve', '${tag}-${p.id}', '2026-01-01', '2026-01-02', 'obs sintetica') RETURNING id)`,
      `o1 AS (INSERT INTO agentes.pedido_origens (pedido_id, reporte_id) SELECT p.id, r.id FROM p, r)`,
    );
  }
  if (p.origem !== 'reporte') {
    ctes.push(
      `v AS (INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas)
             VALUES ('operador-sintetico', 'silente', 'inbox-sintetica', '${tag}-${p.id}', 'msg-sintetica', false) RETURNING id)`,
      `o2 AS (INSERT INTO agentes.pedido_origens (pedido_id, veredicto_id) SELECT p.id, v.id FROM p, v)`,
    );
  }
  if (p.ev) {
    const motivo = p.ev.acao === 'negar' ? `'${p.ev.motivo}'` : 'NULL';
    const comentario = p.ev.acao === 'descrever' ? `'${p.ev.comentario}'` : 'NULL';
    ctes.push(
      `e AS (INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo, comentario, ts)
             SELECT p.id, a.id, '${p.ev.acao}', '${ATOR}', 'humano', ${motivo}, ${comentario}, ${ts} FROM p, a)`,
    );
  }
  return run(`WITH ${ctes.join(',\n')} SELECT id FROM p`);
}

export function seedMassaContador(run: RunSql, tag: string): void {
  for (const p of MASSA) seedUm(run, tag, p);
}

/**
 * MASSA DA DECISÃO (alt 2 do spec de tela): só contador 1 (origem reporte); o humano NEGA o pendente pela tela e o contador cai.
 *
 * pedido | semana | 1º evento                | classe      | efeito
 * -------|--------|--------------------------|-------------|--------------------------------------------
 * N1, N2 |   -7   | aceitar, sem comentário  | limpa       | semana -7 VÁLIDA (2 limpas)
 * N3, N4 |   -6   | aceitar, sem comentário  | limpa       | semana -6 VÁLIDA
 * N5, N6 |   -5   | aceitar, sem comentário  | limpa       | semana -5 VÁLIDA enquanto o NP estiver pendente
 * NP     |   -5   | (nenhum)                 | pendente    | ao NEGAR vira contestação na semana -5 -> ZERA
 *
 * ANTES de negar: 3 de 4 semanas seguidas, "Sin contestaciones", Pedidos: 7, Pendientes: 1.  Contador 2: vazio (0 pedidos).
 * DEPOIS de negar + recarregar: 0 de 4 semanas seguidas, "Última contestación: semana del <segunda da semana -5>", Pedidos: 7, Pendientes: 0.
 */
export const MASSA_NEGAR: PedidoContador[] = [
  { id: 'N1', semanasAtras: 7, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'N2', semanasAtras: 7, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'N3', semanasAtras: 6, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'N4', semanasAtras: 6, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'N5', semanasAtras: 5, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'N6', semanasAtras: 5, origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'NP', semanasAtras: 5, origem: 'reporte', ev: null },
];

export const ESPERADO_NEGAR = {
  antes: { semanas: '3', regua: '3 de 4 semanas seguidas', pedidos: 'Pedidos: 7', pendentes: 'Pendientes: 1', ultima: 'Sin contestaciones' },
  depois: { semanas: '0', regua: '0 de 4 semanas seguidas', pedidos: 'Pedidos: 7', pendentes: 'Pendientes: 0', ultimaSemanasAtras: 5 },
} as const;

/** Semeia a MASSA_NEGAR e devolve o id do pedido PENDENTE (NP), o que o teste vai negar pela tela. */
export function seedMassaNegar(run: RunSql, tag: string): string {
  let pendente = '';
  for (const p of MASSA_NEGAR) {
    const id = seedUm(run, tag, p);
    if (p.id === 'NP') pendente = id;
  }
  return pendente;
}

/** Apaga SÓ a rodada (pedidos/atitudes/eventos/origens pela área, depois reportes e veredictos pela marca). */
export function limparMassaContador(run: RunSql, tag: string): void {
  limparPedidos(run, tag);
  for (const [tabela, coluna] of [['reportes', 'regra_ref'], ['veredictos', 'conversa_ref']] as const) {
    try { run(`DELETE FROM agentes.${tabela} WHERE ${coluna} LIKE '${tag}-%'`); } catch (err) { console.error(`[cleanup] ${tabela} falhou (seguindo)`, err); }
  }
}

/** Pedidos com origem criados nas últimas 28 semanas (janela padrão do endpoint) — o que alimenta os contadores, de QUALQUER rodada. */
export const contarPedidosNaJanela = (run: RunSql): number =>
  Number(run(`SELECT count(DISTINCT p.id) FROM agentes.pedidos p JOIN agentes.pedido_origens o ON o.pedido_id = p.id WHERE p.criado_em >= now() - interval '28 weeks'`));
