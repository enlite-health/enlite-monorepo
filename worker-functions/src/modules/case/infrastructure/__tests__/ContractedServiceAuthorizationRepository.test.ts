const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(),
}));

import { withActorContext } from '@shared/database/actorContext';
import { ContractedServiceAuthorizationRepository } from '../ContractedServiceAuthorizationRepository';
import { AuthorizationNotFoundError, AuthorizationOverlapsError } from '../../domain/ContractedServiceAuthorization';

const W = { serviceId: 'svc-1', hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31', actorUid: 'staff-1' };
const ROW = {
  id: 'a-1', hours: '120', valid: '[2026-01-01,2027-01-01)',
  recorded_at: new Date('2026-10-18T00:00:00Z'), recorded_by: 'staff-1', superseded_at: null,
};

function runWith(query: jest.Mock): void {
  (withActorContext as jest.Mock).mockImplementation(async (_pool: unknown, fn: (c: unknown) => unknown) => fn({ query }));
}

describe('ContractedServiceAuthorizationRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  it('create grava daterange(validFrom, validTo+1) e devolve validTo inclusivo', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [ROW], rowCount: 1 });
    runWith(query);
    const view = await new ContractedServiceAuthorizationRepository().create(W);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('VALUES ($1, $2, $3, $4)');
    expect(sql).not.toContain('daterange(');
    expect(params).toEqual(['svc-1', 120, '[2026-01-01,2027-01-01)', 'staff-1']);
    expect(view.validTo).toBe('2026-12-31');
    expect(view.hours).toBe(120);
  });

  it('list ordena por valid DESC, recorded_at DESC (início, depois fim, depois registro)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await new ContractedServiceAuthorizationRepository().list('svc-1');
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).toContain('ORDER BY valid DESC, recorded_at DESC');
    expect(sql).not.toMatch(/lower\(valid\)/);
  });

  it('supersede faz UPDATE antes do INSERT, no mesmo client', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
    runWith(query);
    await new ContractedServiceAuthorizationRepository().supersede('a-0', W);
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('UPDATE contracted_service_authorization SET superseded_at');
    expect(query.mock.calls[0][1]).toEqual(['a-0', 'svc-1']);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO contracted_service_authorization');
  });

  it('supersede com 0 linhas no UPDATE → NotFound e NÃO insere', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    runWith(query);
    await expect(new ContractedServiceAuthorizationRepository().supersede('a-0', W)).rejects.toBeInstanceOf(
      AuthorizationNotFoundError,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('23P01 em csa_sem_sobreposicao → AuthorizationOverlapsError; outro erro passa intacto', async () => {
    runWith(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '23P01', constraint: 'csa_sem_sobreposicao' })));
    await expect(new ContractedServiceAuthorizationRepository().create(W)).rejects.toBeInstanceOf(AuthorizationOverlapsError);
    const other = new Error('boom');
    runWith(jest.fn().mockRejectedValue(other));
    await expect(new ContractedServiceAuthorizationRepository().create(W)).rejects.toBe(other);
  });
});
