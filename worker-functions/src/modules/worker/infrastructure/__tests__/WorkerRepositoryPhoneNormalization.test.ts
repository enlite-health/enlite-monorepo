/**
 * Testes unitários para normalização de phone na borda do create/updateAuthUid.
 *
 * Contexto: Track C (prevenção de duplicatas) — migration 219.
 * O WorkerRepository.create e WorkerAuthRepository.updateAuthUid devem
 * normalizar o phone via normalizePhoneAR ANTES de gravar no banco,
 * garantindo unicidade semântica alinhada com phone_normalized.
 *
 * ESTRATÉGIA DE TESTE:
 *   Mocks para Pool (pg) e KMSEncryptionService — sem banco real.
 *   Capturamos os valores passados para pool.query para validar normalização.
 */

import { WorkerRepository } from '../WorkerRepository';
import { updateAuthUid } from '../WorkerAuthRepository';

// ─── Helpers de mock ──────────────────────────────────────────────────────────

const makeEncryptionService = () => ({
  encrypt: jest.fn().mockResolvedValue('ENCRYPTED'),
  decrypt: jest.fn().mockResolvedValue(''),
});

const makeBlindIndexService = () => ({
  generateValueBidx: jest.fn().mockResolvedValue(Buffer.alloc(8)),
  generateValuesBidx: jest.fn().mockResolvedValue([]),
  generateTrigramBidx: jest.fn().mockResolvedValue(Buffer.alloc(8)),
});

// Linha fictícia retornada pelo INSERT RETURNING
const fakeWorkerRow = {
  id: 'aa000001-0000-4000-a000-000000000001',
  authUid: 'firebase_uid_abc123',
  email: 'test@example.com',
  phone: '5491151265663',
  lgpdConsentAt: null,
  termsAcceptedAt: null,
  privacyAcceptedAt: null,
  country: 'AR',
  timezone: 'UTC',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── WorkerRepository.create — normalização de phone ─────────────────────────

describe('WorkerRepository.create — normalização de phone (Track C prevenção)', () => {
  let queryCapture: unknown[][] = [];
  let pool: { query: jest.Mock; connect: jest.Mock };
  let repo: WorkerRepository;

  beforeEach(() => {
    queryCapture = [];
    pool = {
      query: jest.fn().mockImplementation((_sql: string, values: unknown[]) => {
        queryCapture.push(values);
        return Promise.resolve({ rows: [fakeWorkerRow] });
      }),
      connect: jest.fn(),
    };

    // Inject pool via módulo (usando jest.mock + manual injection)
    // WorkerRepository usa DatabaseConnection.getInstance().getPool()
    // Substituímos injetando diretamente na instância após construção.
    const encryption = makeEncryptionService();
    const bidx = makeBlindIndexService();

    repo = Object.create(WorkerRepository.prototype) as WorkerRepository;
    // Atribuição direta às propriedades privadas (TypeScript permite via any em testes)
    (repo as unknown as Record<string, unknown>)['pool'] = pool;
    (repo as unknown as Record<string, unknown>)['encryptionService'] = encryption;
    (repo as unknown as Record<string, unknown>)['blindIndexService'] = bidx;
  });

  it('grava phone normalizado 5491151265663 quando recebe 1151265663 (10 dígitos)', async () => {
    const result = await repo.create({
      authUid: 'uid1',
      email: 'a@b.com',
      phone: '1151265663',
    });

    expect(result.isSuccess).toBe(true);
    // $3 no INSERT é o phone (terceiro valor)
    const insertValues = queryCapture[0] as unknown[];
    expect(insertValues[2]).toBe('5491151265663');
  });

  it('grava phone normalizado 5491151265663 quando recebe 541151265663 (12 dígitos sem 9)', async () => {
    await repo.create({
      authUid: 'uid2',
      email: 'b@c.com',
      phone: '541151265663',
    });

    const insertValues = queryCapture[0] as unknown[];
    expect(insertValues[2]).toBe('5491151265663');
  });

  it('mantém phone já canônico 5491151265663 sem alteração', async () => {
    await repo.create({
      authUid: 'uid3',
      email: 'c@d.com',
      phone: '5491151265663',
    });

    const insertValues = queryCapture[0] as unknown[];
    expect(insertValues[2]).toBe('5491151265663');
  });

  it('remove formatação E.164 (+) antes de normalizar', async () => {
    await repo.create({
      authUid: 'uid4',
      email: 'd@e.com',
      phone: '+5491151265663',
    });

    const insertValues = queryCapture[0] as unknown[];
    expect(insertValues[2]).toBe('5491151265663');
  });

  it('grava null quando phone é undefined', async () => {
    await repo.create({
      authUid: 'uid5',
      email: 'e@f.com',
      phone: undefined,
    });

    const insertValues = queryCapture[0] as unknown[];
    expect(insertValues[2]).toBeNull();
  });

  it('grava null quando phone é string vazia', async () => {
    await repo.create({
      authUid: 'uid6',
      email: 'f@g.com',
      phone: '',
    });

    const insertValues = queryCapture[0] as unknown[];
    expect(insertValues[2]).toBeNull();
  });

  it('números de 8 dígitos (incomuns) são gravados como-estão (sem conversão)', async () => {
    await repo.create({
      authUid: 'uid7',
      email: 'g@h.com',
      phone: '12345678',
    });

    const insertValues = queryCapture[0] as unknown[];
    // normalizePhoneAR retorna '12345678' para comprimentos incomuns
    expect(insertValues[2]).toBe('12345678');
  });
});

// ─── WorkerAuthRepository.updateAuthUid — normalização de phone ──────────────

describe('WorkerAuthRepository.updateAuthUid — normalização de phone (Track C prevenção)', () => {
  let pool: { query: jest.Mock };

  const fakeUpdateRow = {
    id: 'bb000002-0000-4000-b000-000000000002',
    authUid: 'new_uid',
    email: 'x@y.com',
    phone: '5491151265663',
    whatsappPhoneEnc: null,
    lgpdConsentAt: null,
    country: 'AR',
    timezone: 'UTC',
    status: 'INCOMPLETE_REGISTER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    pool = {
      query: jest.fn().mockResolvedValue({ rows: [fakeUpdateRow] }),
    };
  });

  const encryption = {
    encrypt: jest.fn().mockResolvedValue('ENC'),
    decrypt: jest.fn().mockResolvedValue(''),
  };

  it('normaliza phone 1151265663 → 5491151265663 no UPDATE', async () => {
    const result = await updateAuthUid(
      pool as never,
      encryption as never,
      'worker-id-123',
      'new_uid',
      '1151265663',
    );

    expect(result.isSuccess).toBe(true);
    // Captura os parâmetros passados para pool.query
    const callArgs = pool.query.mock.calls[0][1] as unknown[];
    // O phone normalizado deve estar no array de params
    expect(callArgs).toContain('5491151265663');
    expect(callArgs).not.toContain('1151265663');
  });

  it('não adiciona phone ao SET quando phone é undefined', async () => {
    await updateAuthUid(
      pool as never,
      encryption as never,
      'worker-id-123',
      'new_uid',
      undefined,
    );

    const sqlQuery = pool.query.mock.calls[0][0] as string;
    // phone não deve aparecer no SET quando não fornecido
    expect(sqlQuery).not.toContain('phone = ');
  });

  it('normaliza phone +5491155261243 (E.164) → 5491155261243 no UPDATE', async () => {
    await updateAuthUid(
      pool as never,
      encryption as never,
      'worker-id-124',
      'new_uid2',
      '+5491155261243',
    );

    const callArgs = pool.query.mock.calls[0][1] as unknown[];
    expect(callArgs).toContain('5491155261243');
    expect(callArgs).not.toContain('+5491155261243');
  });
});
