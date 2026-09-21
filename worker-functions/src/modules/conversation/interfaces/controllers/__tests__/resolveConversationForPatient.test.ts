/**
 * resolveConversationForPatient — spec 022, Bloco 1, LACUNA 3 do fecho do B1.
 *
 * Molde: `patientExistsCheck.ts` não tem teste próprio citado no arquivo-fonte (comentário do
 * arquivo original), então este teste segue o padrão dos demais unit do módulo — `Pool` mockado
 * na fronteira, sem banco real (a colisão de concorrência é PROVADA pela sequência de chamadas
 * que o código faz, não por dois processos reais competindo — isso é o que o unit pode provar;
 * o comportamento real sob concorrência de verdade é papel do Postgres (`UNIQUE(patient_id)`,
 * migration 457) mais o e2e).
 *
 * `withActorContext` mockado inteiro (molde `PostMessageUseCase.test.ts`/
 * `EditDeleteMessageUseCase.test.ts`): o SELECT de leitura (get) roda em `db.query` direto — já
 * roteado pela sessão da request — mas o INSERT e o SELECT de corrida (Tarefa 2 do gate
 * revisao-pr, Bloco 1: sem contexto do ator a policy de RLS derruba o INSERT) rodam DENTRO de
 * `withActorContext`, no client fake que o mock entrega.
 *
 * Quatro provas exigidas:
 *  (a) conversa existente é reaproveitada — nunca cria outra (1 SELECT no pool, 0 chamada a
 *      `withActorContext`).
 *  (b) paciente sem conversa ganha uma (SELECT sem conversationId → `withActorContext` → INSERT
 *      … RETURNING no client).
 *  (c) concorrência: o INSERT perde a corrida (`ON CONFLICT DO NOTHING` sem RETURNING) e o
 *      código RELÊ (no MESMO client) em vez de estourar — nunca lança, sempre devolve o id de
 *      quem venceu.
 */
const mockWithActorContext = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...args: unknown[]) => mockWithActorContext(...args),
}));

import type { Pool, PoolClient } from 'pg';
import { resolveConversationForPatient } from '../resolveConversationForPatient';

function poolWith(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

function clientWith(query: jest.Mock): PoolClient {
  return { query } as unknown as PoolClient;
}

const PATIENT_ID = 'pppppppp-pppp-pppp-pppp-pppppppppppp';

describe('resolveConversationForPatient', () => {
  beforeEach(() => {
    mockWithActorContext.mockReset();
  });

  it('paciente inexistente (ou soft-deleted): devolve patientExists=false, conversationId=null, SEM tentar INSERT nem abrir withActorContext', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });

    const result = await resolveConversationForPatient(poolWith(query), PATIENT_ID);

    expect(result).toEqual({ patientExists: false, conversationId: null });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN conversations');
    expect(sql).toContain('p.deleted_at IS NULL');
    expect(params).toEqual([PATIENT_ID]);
    expect(mockWithActorContext).not.toHaveBeenCalled();
  });

  it('(a) conversa JÁ existe: reaproveita — devolve o id do SELECT, nunca abre withActorContext', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [{ patientId: PATIENT_ID, conversationId: 'conv-existente' }],
    });

    const result = await resolveConversationForPatient(poolWith(query), PATIENT_ID);

    expect(result).toEqual({ patientExists: true, conversationId: 'conv-existente' });
    // nunca cria outra: só o SELECT rodou, nunca entrou na transação do ator.
    expect(query).toHaveBeenCalledTimes(1);
    expect(mockWithActorContext).not.toHaveBeenCalled();
  });

  it('(b) paciente existe SEM conversa: SELECT sem conversationId → withActorContext → INSERT … RETURNING ganha a corrida sozinho, NO CLIENT da transação', async () => {
    const selectQuery = jest.fn().mockResolvedValueOnce({ rows: [{ patientId: PATIENT_ID, conversationId: null }] });
    const clientQuery = jest.fn().mockResolvedValueOnce({ rows: [{ id: 'conv-nova' }] });
    const client = clientWith(clientQuery);
    mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => fn(client));

    const result = await resolveConversationForPatient(poolWith(selectQuery), PATIENT_ID);

    expect(result).toEqual({ patientExists: true, conversationId: 'conv-nova' });
    expect(selectQuery).toHaveBeenCalledTimes(1);
    expect(mockWithActorContext).toHaveBeenCalledTimes(1);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    const [insertSql, insertParams] = clientQuery.mock.calls[0];
    expect(insertSql).toContain('INSERT INTO conversations (patient_id)');
    expect(insertSql).toContain('ON CONFLICT (patient_id) DO NOTHING');
    expect(insertSql).toContain('RETURNING id');
    expect(insertParams).toEqual([PATIENT_ID]);
  });

  it('(c) CONCORRÊNCIA: INSERT perde a corrida (ON CONFLICT DO NOTHING sem RETURNING) — relê no MESMO client em vez de estourar, devolve o id de quem venceu', async () => {
    const selectQuery = jest.fn().mockResolvedValueOnce({ rows: [{ patientId: PATIENT_ID, conversationId: null }] });
    const clientQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // INSERT ON CONFLICT DO NOTHING: perdeu a corrida, 0 linhas
      .mockResolvedValueOnce({ rows: [{ id: 'conv-do-vencedor' }] }); // reléu: acha a linha da outra request
    const client = clientWith(clientQuery);
    mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => fn(client));

    const result = await resolveConversationForPatient(poolWith(selectQuery), PATIENT_ID);

    // nunca lança — a promise resolve normalmente com o id da OUTRA request, nunca duplica.
    expect(result).toEqual({ patientExists: true, conversationId: 'conv-do-vencedor' });
    expect(clientQuery).toHaveBeenCalledTimes(2);
    const [retrySql, retryParams] = clientQuery.mock.calls[1];
    expect(retrySql).toContain('SELECT id FROM conversations WHERE patient_id = $1');
    expect(retryParams).toEqual([PATIENT_ID]);
  });

  it('ramo residual: INSERT perde a corrida E a releitura também não acha nada — devolve conversationId null (nunca lança)', async () => {
    const selectQuery = jest.fn().mockResolvedValueOnce({ rows: [{ patientId: PATIENT_ID, conversationId: null }] });
    const clientQuery = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const client = clientWith(clientQuery);
    mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => fn(client));

    const result = await resolveConversationForPatient(poolWith(selectQuery), PATIENT_ID);

    expect(result).toEqual({ patientExists: true, conversationId: null });
  });
});
