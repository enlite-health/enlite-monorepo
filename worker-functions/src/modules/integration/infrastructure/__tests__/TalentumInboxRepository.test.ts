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
    expect(sql).toContain('ON CONFLICT (body_hash) DO NOTHING');
    expect(values[values.length - 1]).toBe(await kms.encrypt.mock.results[0].value);
    expect(JSON.stringify(values)).not.toContain(SENSITIVE);
  });

  it('duplicado (ON CONFLICT não devolve linha) → busca o id existente e devolve duplicate=true', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'inbox-0' }] });
    const repo = new TalentumInboxRepository(makeKms() as never);

    const r = await repo.insertReceived(params(body));

    expect(r).toEqual({ id: 'inbox-0', duplicate: true });
    expect(mockQuery.mock.calls[1][1]).toEqual([computeBodyHash(body)]);
  });

  it('lockKey toma pg_advisory_xact_lock no client recebido', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await new TalentumInboxRepository(makeKms() as never).lockKey(client, 'tp-1', 'prof-1');
    expect(client.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
  });

  it('pendingForKey: só RECEIVED, ordenado por received_at, mapeado', async () => {
    const at = new Date('2026-11-25T10:00:00Z');
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'i1', received_at: at, action: 'PRESCREENING_RESPONSE', subtype: 'INITIATED', talentum_prescreening_id: 'tp-1', talentum_profile_id: 'prof-1', environment: 'test', state: 'RECEIVED', attempts: 0, payload_enc: 'ENC(x)' }],
      }),
    };
    const rows = await new TalentumInboxRepository(makeKms() as never).pendingForKey(client, 'tp-1', 'prof-1');
    const [sql, values] = client.query.mock.calls[0];
    expect(sql).toContain(`state = 'RECEIVED'`);
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
});
