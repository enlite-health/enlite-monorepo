/**
 * findByAuthUid precisa devolver `isTest` (coluna `workers.is_test`): Start/ConfirmPhoneVerification
 * leem `own.isTest` para suprimir o OTP da ficha própria de teste. Sem o SELECT, vinha sempre undefined.
 * O pool dublê só devolve `isTest` se o SQL realmente selecionar `is_test` — tirar do SELECT quebra aqui.
 */
import { Pool } from 'pg';
import { findByAuthUid } from '../WorkerAuthRepository';
import { Worker } from '../../domain/Worker';

function build(isTestInDb: boolean) {
  const query = jest.fn(async (sql: string) => ({
    rows: [
      {
        id: 'worker-1', authUid: 'uid-teste-1', email: 'w@enlite.test', mergedIntoId: null,
        country: 'AR', timezone: 'America/Argentina/Buenos_Aires', status: 'REGISTERED',
        createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...(/is_test\s+as\s+"isTest"/.test(sql) ? { isTest: isTestInDb } : {}),
      },
    ],
  }));
  const decrypt = jest.fn(async () => '');
  return {
    pool: { query } as unknown as Pool,
    enc: { decrypt } as unknown as import('@shared/security/KMSEncryptionService').KMSEncryptionService,
  };
}

describe('WorkerAuthRepository.findByAuthUid — isTest', () => {
  it('linha com is_test=true → isTest === true', async () => {
    const { pool, enc } = build(true);
    const w = (await findByAuthUid(pool, enc, 'uid-teste-1')).getValue() as Worker;
    expect(w.isTest).toBe(true);
  });

  it('linha com is_test=false → isTest === false', async () => {
    const { pool, enc } = build(false);
    const w = (await findByAuthUid(pool, enc, 'uid-teste-1')).getValue() as Worker;
    expect(w.isTest).toBe(false);
  });
});
