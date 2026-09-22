/**
 * AdminRepository.touchPresence — heartbeat de presença (R2-B, change
 * 022-ux-mencao-e-notificacao Rodada 2). Unit puro (pool mockado): prova que o throttle de 30s
 * está na CLÁUSULA SQL (atômico, sem round-trip de leitura) e que o retorno reflete
 * `rowCount` (se a linha foi de fato regravada). O comportamento real do throttle contra
 * relógio de banco de verdade é coberto pelo e2e de presença.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { AdminRepository } from '../AdminRepository';

describe('AdminRepository.touchPresence', () => {
  beforeEach(() => mockQuery.mockReset());

  it('UPDATE tem o throttle de 30s na cláusula WHERE, com firebase_uid como único parâmetro', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const regravou = await new AdminRepository().touchPresence('uid-1');

    expect(regravou).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('SET last_seen_at = now()');
    expect(String(sql)).toContain("interval '30 seconds'");
    expect(String(sql)).toContain('WHERE firebase_uid = $1');
    expect(params).toEqual(['uid-1']);
  });

  it('rowCount 0 (throttle segurou, valor atual tem menos de 30s) → false', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    expect(await new AdminRepository().touchPresence('uid-1')).toBe(false);
  });

  it('rowCount ausente (driver não devolveu) → false, nunca lança', async () => {
    mockQuery.mockResolvedValue({});
    expect(await new AdminRepository().touchPresence('uid-1')).toBe(false);
  });
});
