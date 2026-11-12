/**
 * pedidos-ia-seed.ts — massa SINTÉTICA dos pedidos do Sol (spec 078, M3b-1) para os e2e da tela `/admin/pedidos-ia`.
 *
 * Não existe rota que CRIE pedido (quem cria é o Sol): o cenário entra por SQL, como os irmãos fazem com paciente/vaga.
 * Dois executores — `sqlViaDocker` (job padrão do CI: `docker exec enlite-postgres psql`, engine OFF) e o `scalar` de
 * `abac-stack-helper.ts` (job ABAC: psql contra a porta do stack). A limpeza usa a conexão de admin (o app é INSERT-only).
 * Cada rodada usa uma ÁREA única: nunca toca pedido de outra rodada, e o filtro por área da tela isola o cenário.
 */
import { execFileSync } from 'child_process';

/** Roda 1 SQL e devolve a 1ª linha da saída (sem cabeçalho). */
export type RunSql = (sql: string) => string;

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';

export const sqlViaDocker: RunSql = (sql) => {
  try {
    const out = execFileSync(
      'docker',
      ['exec', CONTAINER, 'psql', '-U', 'enlite_admin', '-d', 'enlite_e2e', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
      { stdio: 'pipe' },
    ).toString();
    return out.trim().split('\n')[0] ?? '';
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message} | sql=${sql}`);
  }
};

export interface SeedPedidoOpts {
  assunto: string;
  area: string;
  grave?: 'nenhum' | 'nunca' | 'dado' | 'acao_fabricada';
}

/** 1 pedido + 1 atitude (versão 1, degrau 1) e o id do pedido. Sem evento: o status da view é `novo`. */
export function seedPedido(run: RunSql, o: SeedPedidoOpts): string {
  return run(`WITH p AS (
      INSERT INTO agentes.pedidos (assunto, descricao, autor, area, grave_gatilho, registro_versao)
      VALUES ('${o.assunto}', 'descricao sintetica', 'sol', '${o.area}', '${o.grave ?? 'nenhum'}', 'r1') RETURNING id
    ), a AS (
      INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
      SELECT id, 1, 1, 'conteudo sintetico', 'caso sintetico', 'metrica sintetica', '7d', 'rollback sintetico' FROM p
    ) SELECT id FROM p`);
}

export const contarEventos = (run: RunSql, pedidoId: string): number =>
  Number(run(`SELECT count(*) FROM agentes.pedido_eventos WHERE pedido_id = '${pedidoId}'`));

export const ultimoEvento = (run: RunSql, pedidoId: string): string =>
  run(`SELECT acao || '|' || actor_uid || '|' || actor_kind FROM agentes.pedido_eventos WHERE pedido_id = '${pedidoId}' ORDER BY ts DESC, id DESC LIMIT 1`);

export function limparPedidos(run: RunSql, area: string): void {
  const ids = `(SELECT id FROM agentes.pedidos WHERE area = '${area}')`;
  for (const t of ['pedido_eventos', 'pedido_atitudes', 'pedido_origens']) {
    try { run(`DELETE FROM agentes.${t} WHERE pedido_id IN ${ids}`); } catch (err) { console.error(`[cleanup] ${t} falhou (seguindo)`, err); }
  }
  try { run(`DELETE FROM agentes.pedidos WHERE area = '${area}'`); } catch (err) { console.error('[cleanup] pedidos falhou (seguindo)', err); }
}
