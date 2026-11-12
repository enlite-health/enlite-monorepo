/**
 * `findByEmail` é do LOGIN (InitWorkerUseCase religa o auth_uid; LookupWorkerByEmailUseCase): comportamento EXATO de
 * sempre — `email = $1`, sem normalizar, sem escolher entre candidatos. A normalização é do `findByEmailNormalized`
 * (webhook Talentum): LOWER(BTRIM) dos dois lados (índice 564), só worker vivo, ORDER BY determinístico, >1 = ambíguo.
 */
import { WorkerRepository } from '../WorkerRepository';

const makeRepo = (rows: unknown[]) => {
  const pool = { query: jest.fn().mockResolvedValue({ rows }), connect: jest.fn() };
  const enc = { encrypt: jest.fn(), decrypt: jest.fn().mockResolvedValue('') };
  const repo = Object.create(WorkerRepository.prototype) as WorkerRepository;
  Object.assign(repo, { pool, encryptionService: enc });
  return { repo, pool };
};

describe('WorkerRepository.findByEmail — LOGIN continua exato', () => {
  it('compara `email = $1` cru: sem LOWER/BTRIM e sem filtro de merged (comportamento anterior)', async () => {
    const { repo, pool } = makeRepo([{ id: 'w-1', email: 'maria@gmail.com', whatsappPhoneEnc: null }]);

    const result = await repo.findByEmail('  Maria@Gmail.COM ');

    expect(result.getValue()?.id).toBe('w-1');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM workers WHERE email = \$1/);
    expect(sql).not.toMatch(/LOWER|BTRIM/i);
    expect(params).toEqual(['  Maria@Gmail.COM ']);
  });
});

describe('WorkerRepository.findByEmailNormalized — só webhook/scripts do Talentum', () => {
  it('normaliza os dois lados, filtra vivo e ordena de forma determinística', async () => {
    const { repo, pool } = makeRepo([{ id: 'w-1', whatsappPhoneEnc: null }]);

    const res = await repo.findByEmailNormalized('  Maria@Gmail.COM ');

    expect(res.getValue()?.id).toBe('w-1');
    expect(res.ambiguousCount).toBe(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/LOWER\(BTRIM\(email\)\)\s*=\s*LOWER\(BTRIM\(\$1\)\)/);
    expect(sql).toMatch(/merged_into_id IS NULL AND deleted_at IS NULL/);
    expect(sql).toMatch(/ORDER BY created_at, id/);
    expect(params).toEqual(['  Maria@Gmail.COM ']);
  });

  it('2 candidatos = AMBÍGUO: devolve null + ambiguousCount (nunca rows[0])', async () => {
    const { repo } = makeRepo([{ id: 'w-1', whatsappPhoneEnc: null }, { id: 'w-2', whatsappPhoneEnc: null }]);

    const res = await repo.findByEmailNormalized('maria@gmail.com');

    expect(res.getValue()).toBeNull();
    expect(res.ambiguousCount).toBe(2);
  });

  it('nenhum candidato → null, ambiguousCount 0', async () => {
    const { repo } = makeRepo([]);
    const res = await repo.findByEmailNormalized('x@y.com');
    expect(res.getValue()).toBeNull();
    expect(res.ambiguousCount).toBe(0);
  });
});

describe('includeMerged (só o webhook Talentum) — os demais callers não mudam', () => {
  it('findByEmailNormalized com includeMerged: sem filtro de merged, deletado fora, devolve todos os ids', async () => {
    const { repo, pool } = makeRepo([{ id: 'w-f1', whatsappPhoneEnc: null }, { id: 'w-f2', whatsappPhoneEnc: null }]);

    const res = await repo.findByEmailNormalized('x@exemplo.invalid', { includeMerged: true });

    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/merged_into_id/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(res.ids).toEqual(['w-f1', 'w-f2']);
  });

  it('findByPhoneCandidates: sem a opção continua filtrando merged; com a opção devolve os ids dos fundidos', async () => {
    const { repo, pool } = makeRepo([{ id: 'w-f1' }]);

    await repo.findByPhoneCandidates(['5491100000000']);
    expect(pool.query.mock.calls[0][0]).toMatch(/merged_into_id IS NULL/);

    const res = await repo.findByPhoneCandidates(['5491100000000'], { includeMerged: true });
    const sql = pool.query.mock.calls[1][0];
    expect(sql).not.toMatch(/merged_into_id/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(res.ids).toEqual(['w-f1']);
    expect(res.getValue()?.id).toBe('w-f1');
  });
});
