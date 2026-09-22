/**
 * PresenceRepository.touchPresence — heartbeat de presença (change 022-ux-mencao-e-notificacao,
 * Rodada 2, reescrito 22/09/2026 para tabela própria `staff_presence`). Unit puro (pool mockado):
 * prova que a escrita é um UPSERT em `staff_presence` — NUNCA um `UPDATE users` (essa era a causa
 * do defeito medido: `UPDATE users` disparava o trigger `update_users_updated_at` e contaminava
 * `users.updated_at` a cada heartbeat) — e que o throttle de 30s está na cláusula `WHERE` do
 * `ON CONFLICT DO UPDATE` (atômico, sem round-trip de leitura). O comportamento real do throttle
 * contra relógio de banco de verdade, e a prova de que `users.updated_at` não muda, são cobertos
 * pelo e2e de presença (Postgres real).
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { PresenceRepository } from '../PresenceRepository';

describe('PresenceRepository.touchPresence', () => {
  beforeEach(() => mockQuery.mockReset());

  it('UPSERT em staff_presence (nunca UPDATE users), com throttle de 30s no WHERE do ON CONFLICT', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const regravou = await new PresenceRepository().touchPresence('uid-1');

    expect(regravou).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    const sqlStr = String(sql);
    // 🔒 Guarda dura: se alguém trocar isto de volta para `UPDATE users SET last_seen_at`, este
    // teste tem de morrer — é exatamente o defeito que esta reescrita corrige (heartbeat batendo
    // `users.updated_at` via trigger).
    expect(sqlStr).not.toMatch(/UPDATE\s+users\b/i);
    expect(sqlStr).toContain('INSERT INTO staff_presence');
    expect(sqlStr).toContain('ON CONFLICT (firebase_uid) DO UPDATE');
    expect(sqlStr).toContain("interval '30 seconds'");
    expect(params).toEqual(['uid-1']);
  });

  it('rowCount 0 (throttle segurou, valor atual tem menos de 30s) → false', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    expect(await new PresenceRepository().touchPresence('uid-1')).toBe(false);
  });

  it('rowCount ausente (driver não devolveu) → false, nunca lança', async () => {
    mockQuery.mockResolvedValue({});
    expect(await new PresenceRepository().touchPresence('uid-1')).toBe(false);
  });
});
