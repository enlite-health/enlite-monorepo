/**
 * WorkerLinkRepository — Pool MOCKADO (jest), sem Postgres real (SQL de verdade é o e2e).
 */
import { WorkerLinkRepository } from '../WorkerLinkRepository';

function mockPool(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as import('pg').Pool;
}

describe('WorkerLinkRepository', () => {
  it('lista vazia de ids devolve Map vazia SEM tocar o pool (evita SELECT com ANY($1) vazio)', async () => {
    const pool = mockPool();
    const repo = new WorkerLinkRepository(pool);
    const out = await repo.findByAnaCareIds([]);
    expect(out.size).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('busca em UM SÓ SELECT para múltiplos ids (nunca 1-por-turno)', async () => {
    const pool = mockPool([
      { ana_care_id: 'AC-NURSE-0-0', id: 'worker-1', first_name_encrypted: 'enc-first-1', last_name_encrypted: 'enc-last-1' },
      { ana_care_id: 'AC-NURSE-0-1', id: 'worker-2', first_name_encrypted: null, last_name_encrypted: null },
    ]);
    const repo = new WorkerLinkRepository(pool);
    const out = await repo.findByAnaCareIds(['AC-NURSE-0-0', 'AC-NURSE-0-1', 'AC-NURSE-0-2']);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(sql).toMatch(/ana_care_id = ANY\(\$1::text\[\]\)/);
    expect(sql).toMatch(/merged_into_id IS NULL/);
    expect(params).toEqual([['AC-NURSE-0-0', 'AC-NURSE-0-1', 'AC-NURSE-0-2']]);

    expect(out.size).toBe(2);
    expect(out.get('AC-NURSE-0-0')).toEqual({ workerId: 'worker-1', firstNameEncrypted: 'enc-first-1', lastNameEncrypted: 'enc-last-1' });
    expect(out.get('AC-NURSE-0-1')).toEqual({ workerId: 'worker-2', firstNameEncrypted: null, lastNameEncrypted: null });
  });

  it('id sem match no banco simplesmente não entra na Map (sem vínculo)', async () => {
    const pool = mockPool([]);
    const repo = new WorkerLinkRepository(pool);
    const out = await repo.findByAnaCareIds(['AC-NURSE-INEXISTENTE']);
    expect(out.has('AC-NURSE-INEXISTENTE')).toBe(false);
  });
});
