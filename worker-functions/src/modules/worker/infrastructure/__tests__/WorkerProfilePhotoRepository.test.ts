/**
 * D815 — a foto é a coluna cifrada `profile_photo_url_encrypted`; apagar = NULL naquela ficha.
 * Pool falso de propósito: aqui só se prova o SQL e a idempotência; a prova contra Postgres real é o e2e do CI.
 */
import { Pool } from 'pg';
import { clearProfilePhoto } from '../WorkerProfilePhotoRepository';

describe('clearProfilePhoto', () => {
  it('zera só profile_photo_url_encrypted da ficha pedida', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const r = await clearProfilePhoto({ query } as unknown as Pool, 'w-1');
    expect(r.isSuccess).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/profile_photo_url_encrypted\s*=\s*NULL/);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(params).toEqual(['w-1']);
  });

  it('sem foto (rowCount 0 / já NULL) continua sucesso — idempotente', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0 });
    const r = await clearProfilePhoto({ query } as unknown as Pool, 'w-1');
    expect(r.isSuccess).toBe(true);
  });

  it('erro do banco vira Result.fail sem lançar', async () => {
    const query = jest.fn().mockRejectedValue(new Error('conn'));
    const r = await clearProfilePhoto({ query } as unknown as Pool, 'w-1');
    expect(r.isFailure).toBe(true);
  });
});
