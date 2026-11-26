/**
 * TalentumInboxRepository.test.ts — T-095-20 (spec 095 §3.2).
 *
 * (a) mesmo corpo com ordem de chaves diferente → mesmo hash (domínio);
 * (b) o payload passado ao SQL é o CIFRADO: espião no KMS, texto plano em nenhum parâmetro.
 * KMS e pg são dublês; dados sintéticos.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { TalentumInboxRepository } from '../TalentumInboxRepository';
import { computeBodyHash, canonicalJson } from '../../domain/TalentumInbox';

const SENSITIVE = 'sintetico.nome@example.test';
const body = { action: 'PRESCREENING_RESPONSE', data: { profile: { id: 'p1', email: SENSITIVE }, list: [{ b: 1, a: 2 }] } };

function makeKms() {
  return {
    encrypt: jest.fn(async (s: string | null | undefined) => (s ? `ENC(${Buffer.from(s).toString('base64')})` : null)),
    decrypt: jest.fn(async (s: string | null | undefined) => Buffer.from(String(s).slice(4, -1), 'base64').toString('utf8')),
  };
}

const params = (payload: unknown) => ({
  bodyHash: computeBodyHash(payload),
  action: 'PRESCREENING_RESPONSE',
  subtype: 'ANALYZED',
  statusLabel: 'QUALIFIED',
  prescreeningId: 'tp-1',
  profileId: 'prof-1',
  environment: 'production' as const,
  ingressHost: 'api.example.test',
  payload,
});

describe('bodyHash (domínio)', () => {
  it('(a) mesmo corpo com ordem de chaves diferente → mesmo hash', () => {
    const reordered = { data: { list: [{ a: 2, b: 1 }], profile: { email: SENSITIVE, id: 'p1' } }, action: 'PRESCREENING_RESPONSE' };
    expect(computeBodyHash(reordered)).toBe(computeBodyHash(body));
    expect(computeBodyHash(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('corpo diferente → hash diferente; ordem de array importa', () => {
    expect(computeBodyHash({ a: [1, 2] })).not.toBe(computeBodyHash({ a: [2, 1] }));
    expect(computeBodyHash({ a: 1 })).not.toBe(computeBodyHash({ a: 2 }));
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });
});

describe('TalentumInboxRepository', () => {
  beforeEach(() => mockQuery.mockReset());

  it('(b) o payload passado ao SQL é o cifrado: texto plano em nenhum parâmetro', async () => {
    const kms = makeKms();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'inbox-1' }] });
    const repo = new TalentumInboxRepository(kms as never);

    const r = await repo.insertReceived(params(body));

    expect(r).toEqual({ id: 'inbox-1', duplicate: false });
    expect(kms.encrypt).toHaveBeenCalledWith(JSON.stringify(body));
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('ORDER BY received_at DESC, id DESC LIMIT 1'); // dedup só contra o último da chave
    expect(sql).not.toContain('ON CONFLICT (body_hash)');
    expect(values[values.length - 1]).toBe(await kms.encrypt.mock.results[0].value);
    expect(JSON.stringify(values)).not.toContain(SENSITIVE);
  });

  it('duplicado (ON CONFLICT não devolve linha) → busca o id existente e devolve duplicate=true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'inbox-0' }] });
    const repo = new TalentumInboxRepository(makeKms() as never);

    const r = await repo.insertReceived(params(body));

    expect(r).toEqual({ id: 'inbox-0', duplicate: true });
    expect(mockQuery.mock.calls[1][1]).toEqual([computeBodyHash(body), 'tp-1', 'prof-1']);
  });

  /**
   * Pool que EXECUTA a semântica que o SQL declara: com `ON CONFLICT (body_hash)` o dedup é global (comportamento antigo);
   * com o `ORDER BY received_at DESC ... LIMIT 1` por chave, só o último evento da chave conta.
   */
  function statefulPool() {
    const rows: Array<{ id: string; hash: string; psc: string | null; prof: string | null }> = [];
    const lastOfKey = (psc: unknown, prof: unknown) => [...rows].reverse().find((r) => r.psc === psc && r.prof === prof);
    mockQuery.mockImplementation(async (sql: string, v: unknown[]) => {
      if (sql.startsWith('INSERT')) {
        const [hash, , , , psc, prof] = v as string[];
        const dup = sql.includes('ON CONFLICT (body_hash)') ? rows.some((r) => r.hash === hash) : lastOfKey(psc, prof)?.hash === hash;
        if (dup) return { rows: [] };
        const id = `i${rows.length + 1}`;
        rows.push({ id, hash, psc, prof });
        return { rows: [{ id }] };
      }
      const [hash, psc, prof] = v as string[];
      const found = sql.includes('ORDER BY received_at DESC') ? lastOfKey(psc, prof) : rows.find((r) => r.hash === hash);
      return { rows: found ? [{ id: found.id }] : [] };
    });
    return rows;
  }

  it('dedup só contra o ÚLTIMO da chave: A, B, A grava 3 linhas; A, A grava 1', async () => {
    const A = { ...body, n: 'A' };
    const B = { ...body, n: 'B' };
    const repo = new TalentumInboxRepository(makeKms() as never);

    const rows = statefulPool();
    const r1 = await repo.insertReceived(params(A));
    const r2 = await repo.insertReceived(params(B));
    const r3 = await repo.insertReceived(params(A));
    expect([r1.duplicate, r2.duplicate, r3.duplicate]).toEqual([false, false, false]);
    expect(rows).toHaveLength(3);

    const rows2 = statefulPool();
    const a1 = await repo.insertReceived(params(A));
    const a2 = await repo.insertReceived(params(A));
    expect(a2).toEqual({ id: a1.id, duplicate: true });
    expect(rows2).toHaveLength(1);
  });

  it('lockKey toma pg_advisory_xact_lock no client recebido', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await new TalentumInboxRepository(makeKms() as never).lockKey(client, 'tp-1', 'prof-1');
    expect(client.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
  });

  it('pendingForKey: RECEIVED e FAILED, ordenado por received_at, mapeado', async () => {
    const at = new Date('2026-11-25T10:00:00Z');
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'i1', received_at: at, action: 'PRESCREENING_RESPONSE', subtype: 'INITIATED', talentum_prescreening_id: 'tp-1', talentum_profile_id: 'prof-1', environment: 'test', state: 'RECEIVED', attempts: 0, payload_enc: 'ENC(x)' }],
      }),
    };
    const rows = await new TalentumInboxRepository(makeKms() as never).pendingForKey(client, 'tp-1', 'prof-1');
    const [sql, values] = client.query.mock.calls[0];
    expect(sql).toContain(`state IN ('RECEIVED', 'FAILED')`); // a FAILED mais antiga não fica de fora (a mais nova não passa na frente)
    expect(sql).toContain('ORDER BY received_at');
    expect(values).toEqual(['tp-1', 'prof-1', []]);
    expect(rows[0]).toMatchObject({ id: 'i1', receivedAt: at, payloadEnc: 'ENC(x)', state: 'RECEIVED', talentumPrescreeningId: 'tp-1', talentumProfileId: 'prof-1' });
  });

  it('pendingForKey com alsoIds: a linha pedida entra fora de RECEIVED, mas nunca PROCESSED', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await new TalentumInboxRepository(makeKms() as never).pendingForKey(client, 'tp-1', 'prof-1', ['i9']);
    const [sql, values] = client.query.mock.calls[0];
    expect(sql).toContain(`id = ANY($3::uuid[]) AND state <> 'PROCESSED'`);
    expect(values).toEqual(['tp-1', 'prof-1', ['i9']]);
  });

  it('findById: devolve a linha mapeada (com a chave) ou null', async () => {
    const at = new Date('2026-11-25T10:00:00Z');
    const client = { query: jest.fn() };
    client.query.mockResolvedValueOnce({ rows: [{ id: 'i1', received_at: at, action: 'PRESCREENING', subtype: 'CREATED', talentum_prescreening_id: 'tp-1', talentum_profile_id: null, environment: 'production', state: 'FAILED', attempts: 2, payload_enc: null }] });
    client.query.mockResolvedValueOnce({ rows: [] });
    const repo = new TalentumInboxRepository(makeKms() as never);
    expect(await repo.findById(client, 'i1')).toMatchObject({ id: 'i1', state: 'FAILED', attempts: 2, talentumPrescreeningId: 'tp-1', talentumProfileId: null });
    expect(client.query.mock.calls[0][1]).toEqual(['i1']);
    expect(await repo.findById(client, 'nao-existe')).toBeNull();
  });

  it('decryptPayload devolve o objeto original', async () => {
    const kms = makeKms();
    const enc = (await kms.encrypt(JSON.stringify(body))) as string;
    expect(await new TalentumInboxRepository(kms as never).decryptPayload({ payloadEnc: enc })).toEqual(body);
  });

  it('markProcessed / markFailed / markState gravam o estado e o código sem PII', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repo = new TalentumInboxRepository(makeKms() as never);
    await repo.markProcessed(client, 'i1');
    await repo.markFailed(client, 'i2', 'code=23505 constraint=x');
    await repo.markState(client, 'i3', 'REJECTED_SCHEMA', null);
    expect(client.query.mock.calls[0][0]).toContain(`state = 'PROCESSED'`);
    expect(client.query.mock.calls[1]).toEqual([expect.stringContaining(`state = 'FAILED'`), ['i2', 'code=23505 constraint=x']]);
    expect(client.query.mock.calls[2][1]).toEqual(['i3', 'REJECTED_SCHEMA', null]);
  });

  describe('predicado da chave (usa idx_talentum_webhook_inbox_key)', () => {
    const norm = (q: string) => q.replace(/\s+/g, ' ');

    it('ids preenchidos → `=` nos dois ids, nas duas consultas, sem IS NOT DISTINCT FROM', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x' }] });
      await new TalentumInboxRepository(makeKms() as never).insertReceived(params(body));
      for (const [sql] of mockQuery.mock.calls) {
        const q = norm(sql);
        expect(q).not.toContain('IS NOT DISTINCT FROM');
        expect(q).toMatch(/talentum_prescreening_id = \$\d::text AND talentum_profile_id = \$\d::text/);
      }
    });

    it('id NULL (PRESCREENING / action desconhecida) → IS NOT DISTINCT FROM nas duas consultas', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x' }] });
      await new TalentumInboxRepository(makeKms() as never).insertReceived({ ...params(body), profileId: null });
      for (const [sql] of mockQuery.mock.calls) {
        const q = norm(sql);
        expect(q).toContain('talentum_prescreening_id IS NOT DISTINCT FROM');
        expect(q).toContain('talentum_profile_id IS NOT DISTINCT FROM');
      }
    });

    it.each([
      ['ids preenchidos', { prescreeningId: 'tp-1', profileId: 'prof-1' }],
      ['profileId NULL', { prescreeningId: 'tp-1', profileId: null }],
      ['os dois NULL', { prescreeningId: null, profileId: null }],
    ])('%s: A→B→A grava 3 linhas; A→A grava 1', async (_n, ids) => {
      const A = { ...body, n: 'A' };
      const B = { ...body, n: 'B' };
      const repo = new TalentumInboxRepository(makeKms() as never);
      const rows = statefulPool();
      const r = [await repo.insertReceived({ ...params(A), ...ids }), await repo.insertReceived({ ...params(B), ...ids }), await repo.insertReceived({ ...params(A), ...ids })];
      expect(r.map((x) => x.duplicate)).toEqual([false, false, false]);
      expect(rows).toHaveLength(3);
      const rows2 = statefulPool();
      const a1 = await repo.insertReceived({ ...params(A), ...ids });
      const a2 = await repo.insertReceived({ ...params(A), ...ids });
      expect(a2).toEqual({ id: a1.id, duplicate: true });
      expect(rows2).toHaveLength(1);
    });
  });
});
