/**
 * suggestSurvivorId.test.ts
 *
 * Cobre a heurística de sugestão de sobrevivente: tier1 único vence;
 * caso contrário, mais atividade → login_real → mais antigo.
 * Garante que NUNCA retorna undefined (raiz do crash em prod).
 */

import { suggestSurvivorId } from '../suggestSurvivorId';
import type { DedupWorkerAccountDetail } from '../DedupTypes';

function acc(over: Partial<DedupWorkerAccountDetail> & { id: string }): DedupWorkerAccountDetail {
  return {
    email: `${over.id}@e.com`,
    tier: 3,
    status: 'INCOMPLETE',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    wja_count: 0,
    docs_count: 0,
    encuadres_count: 0,
    login_real: false,
    auth_uid_prefix: 'base1import_',
    is_imported: true,
    profession: null,
    country: null,
    has_encrypted_pii: false,
    ...over,
  };
}

describe('suggestSurvivorId', () => {
  it('única conta tier1 vence', () => {
    const accounts = [
      acc({ id: 'a', tier: 1, login_real: true }),
      acc({ id: 'b', tier: 3, wja_count: 99 }),
    ];
    expect(suggestSurvivorId(accounts)).toBe('a');
  });

  it('sem tier1: escolhe maior atividade (wja+docs+encuadres)', () => {
    const accounts = [
      acc({ id: 'a', wja_count: 1 }),
      acc({ id: 'b', wja_count: 3, docs_count: 2 }),
    ];
    expect(suggestSurvivorId(accounts)).toBe('b');
  });

  it('empate de atividade: login_real desempata', () => {
    const accounts = [
      acc({ id: 'a', login_real: false }),
      acc({ id: 'b', login_real: true }),
    ];
    expect(suggestSurvivorId(accounts)).toBe('b');
  });

  it('empate total: mais antigo (created_at) vence', () => {
    const accounts = [
      acc({ id: 'a', created_at: '2026-03-01T00:00:00.000Z' }),
      acc({ id: 'b', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(suggestSurvivorId(accounts)).toBe('b');
  });

  it('múltiplas tier1 → cai na atividade (não há "única tier1")', () => {
    const accounts = [
      acc({ id: 'a', tier: 1, wja_count: 1 }),
      acc({ id: 'b', tier: 1, wja_count: 9 }),
    ];
    expect(suggestSurvivorId(accounts)).toBe('b');
  });

  it('1 conta só → retorna o id (nunca undefined)', () => {
    expect(suggestSurvivorId([acc({ id: 'solo' })])).toBe('solo');
  });
});
