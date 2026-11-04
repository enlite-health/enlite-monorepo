import type { Pool } from 'pg';
import { PostgresPedidoIaRepository } from '../PostgresPedidoIaRepository';
import { PedidoJaDecididoError } from '../../domain/PedidoIa';

const queries: string[] = [];
let decidido = false;
const client = {
  query: jest.fn(async (sql: string) => {
    queries.push(sql);
    if (sql.includes('FROM agentes.pedido_atitudes')) return { rows: [{ id: 'atitude-1' }] };
    if (sql.includes("acao IN ('aceitar', 'negar')")) return { rows: decidido ? [{ '?column?': 1 }] : [] };
    if (sql.includes('INSERT INTO agentes.pedido_eventos')) return { rows: [{ id: 'ev-1' }] };
    if (sql.includes('agentes.pedido_status')) return { rows: [{ status: 'descrito' }] };
    return { rows: [] };
  }),
};

jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn(client)),
}));

const idx = (trecho: string) => queries.findIndex((q) => q.includes(trecho));
const input = { pedidoId: 'p1', acao: 'descrever' as const, actorUid: 'u1' };

describe('PostgresPedidoIaRepository.decidir — lock descrever × aceitar', () => {
  beforeEach(() => {
    queries.length = 0;
    decidido = false;
  });

  it('toma o advisory lock da atitude ANTES da checagem "já decidido" e do INSERT', async () => {
    await new PostgresPedidoIaRepository({} as Pool).decidir(input);
    const lock = idx('pg_advisory_xact_lock');
    expect(lock).toBeGreaterThan(idx('FROM agentes.pedido_atitudes'));
    expect(lock).toBeLessThan(idx("acao IN ('aceitar', 'negar')"));
    expect(lock).toBeLessThan(idx('INSERT INTO agentes.pedido_eventos'));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['pedido_atitude:atitude-1']);
  });

  it('o lock também cobre aceitar/negar (é o que fecha a corrida com o descrever)', async () => {
    await new PostgresPedidoIaRepository({} as Pool).decidir({ ...input, acao: 'aceitar' });
    expect(idx('pg_advisory_xact_lock')).toBeLessThan(idx('INSERT INTO agentes.pedido_eventos'));
  });

  it('descrever depois de decisão já registrada → PedidoJaDecididoError sem INSERT', async () => {
    decidido = true;
    await expect(new PostgresPedidoIaRepository({} as Pool).decidir(input)).rejects.toBeInstanceOf(PedidoJaDecididoError);
    expect(idx('INSERT INTO agentes.pedido_eventos')).toBe(-1);
  });
});
