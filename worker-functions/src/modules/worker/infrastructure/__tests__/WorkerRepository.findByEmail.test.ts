/**
 * WorkerRepository.findByEmail — o Talentum manda o e-mail como a candidata digitou ("Maria@Gmail.com ", com
 * maiúscula/espaço). O lookup compara LOWER(BTRIM(email)) dos DOIS lados (migration 564 tem o índice da mesma
 * expressão); `email = $1` cru deixava a candidata sem worker e o fluxo criava uma duplicata.
 */
import { WorkerRepository } from '../WorkerRepository';

const makeRepo = (rows: unknown[]) => {
  const pool = { query: jest.fn().mockResolvedValue({ rows }), connect: jest.fn() };
  const enc = { encrypt: jest.fn(), decrypt: jest.fn().mockResolvedValue('') };
  const repo = Object.create(WorkerRepository.prototype) as WorkerRepository;
  Object.assign(repo, { pool, encryptionService: enc });
  return { repo, pool };
};

describe('WorkerRepository.findByEmail — normalização', () => {
  it('compara LOWER(BTRIM()) dos dois lados e passa o e-mail como veio (maiúscula/espaço)', async () => {
    const { repo, pool } = makeRepo([{ id: 'w-1', email: 'maria@gmail.com', whatsappPhoneEnc: null }]);

    const result = await repo.findByEmail('  Maria@Gmail.COM ');

    expect(result.getValue()?.id).toBe('w-1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/LOWER\(BTRIM\(email\)\)\s*=\s*LOWER\(BTRIM\(\$1\)\)/);
    expect(params).toEqual(['  Maria@Gmail.COM ']);
  });
});
