import { createHash } from 'crypto';
import { PgOtpSendLedger } from '../PgOtpSendLedger';

const UID = 'uid-teste-ledger';

function montar(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { query, ledger: new PgOtpSendLedger({ query } as never) };
}

describe('PgOtpSendLedger', () => {
  it('record: requester_hash enviado ao pool tem 64 hex, é o sha256 do uid e NÃO é o uid', async () => {
    const { query, ledger } = montar();
    await ledger.record({ challengeId: 'ch-1', adapter: 'verify', purpose: 'link', requesterUid: UID, targetWorkerId: 'w-1', suppressed: false });
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[3]).not.toBe(UID);
    expect(params[3]).toBe(createHash('sha256').update(UID).digest('hex'));
    expect(JSON.stringify(params)).not.toContain(UID);
    expect(params).toEqual(['ch-1', 'verify', 'link', params[3], 'w-1', false]);
  });

  it('record: adapter own grava target_worker_id null', async () => {
    const { query, ledger } = montar();
    await ledger.record({ challengeId: 'ch-2', adapter: 'own', purpose: 'claim', requesterUid: UID, targetWorkerId: null, suppressed: true });
    expect((query.mock.calls[0][1] as unknown[])[4]).toBeNull();
    expect((query.mock.calls[0][1] as unknown[])[5]).toBe(true);
  });

  it('sentToday: devolve o n da consulta, que exclui suprimidos e usa o dia de Buenos Aires', async () => {
    const { query, ledger } = montar([{ n: 7 }]);
    await expect(ledger.sentToday()).resolves.toBe(7);
    expect(query.mock.calls[0][0]).toContain('NOT suppressed');
    expect(query.mock.calls[0][0]).toContain('America/Argentina/Buenos_Aires');
  });

  describe('findClaimTarget', () => {
    const Q = { challengeId: 'ch-9', requesterUid: UID, withinMinutes: 10 };

    it('devolve o worker_id da linha e manda o requester_hash como sha256 do uid (nunca o uid)', async () => {
      const { query, ledger } = montar([{ worker_id: 'w-1' }]);
      await expect(ledger.findClaimTarget(Q)).resolves.toBe('w-1');
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('COALESCE(e.target_worker_id, c.worker_id)');
      expect(sql).toContain('AND e.requester_hash = $2');
      expect(sql).toContain("e.purpose = 'claim'");
      expect(params).toEqual(['ch-9', createHash('sha256').update(UID).digest('hex'), 10]);
      expect(JSON.stringify(params)).not.toContain(UID);
    });

    it('sem linha (outro requisitante ou fora da janela) → null', async () => {
      const { ledger } = montar([]);
      await expect(ledger.findClaimTarget(Q)).resolves.toBeNull();
    });
  });

  it('erro do pool sobe', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db fora'));
    await expect(new PgOtpSendLedger({ query } as never).record({
      challengeId: 'c', adapter: 'own', purpose: 'claim', requesterUid: UID, targetWorkerId: null, suppressed: false,
    })).rejects.toThrow('db fora');
  });
});
