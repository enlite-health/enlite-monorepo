/**
 * admin-workers-api-search.test.ts
 *
 * Testa a busca por nome via blind index trigram (migration 167) no endpoint
 * GET /api/admin/workers?search=<termo>.
 *
 * Setup: 3 workers fixture inseridos diretamente no banco com name_trgm_bidx
 * gerado pelo BlindIndexService em testMode (chave HMAC fixa — determinístico).
 * Identificados pelo sufixo @bidx-e2e.local para cleanup limpo.
 */

import { Pool } from 'pg';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Fixture helper ────────────────────────────────────────────────────────────

async function createWorkerFixture(
  pool: Pool,
  kms: KMSEncryptionService,
  bidx: BlindIndexService,
  opts: { firstName: string; lastName: string; email: string; phone: string },
): Promise<string> {
  const [firstNameEnc, lastNameEnc, bidxBuffers] = await Promise.all([
    kms.encrypt(opts.firstName),
    kms.encrypt(opts.lastName),
    bidx.generateNameTrigramBidx(opts.firstName, opts.lastName),
  ]);
  const bidxLiteral = bidx.serializeForPg(bidxBuffers);

  const result = await pool.query(
    `INSERT INTO workers (
       auth_uid, email, phone, status, country, timezone,
       first_name_encrypted, last_name_encrypted, name_trgm_bidx
     )
     VALUES ($1, $2, $3, 'REGISTERED', 'AR', 'America/Buenos_Aires', $4, $5, $6::bytea[])
     RETURNING id`,
    [
      `bidx-e2e-${opts.email}`,
      opts.email,
      opts.phone,
      firstNameEnc,
      lastNameEnc,
      bidxLiteral,
    ],
  );
  return result.rows[0].id as string;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('GET /api/admin/workers — busca por nome (blind index)', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;

  const kms = new KMSEncryptionService();
  const bidx = new BlindIndexService();

  // IDs dos workers criados no beforeAll — usados para assertions pontuais
  let idGabriel: string;
  let idMaria: string;
  let idCarlos: string;

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  /** Extrai os emails dos workers retornados pela API. */
  function emails(res: { data: { data: Array<{ email: string }> } }): string[] {
    return res.data.data.map((w) => w.email);
  }

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'bidx-search-admin-e2e',
      email: 'bidx-search-admin@e2e.local',
      role: 'admin',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Limpar fixtures antigas (idempotente — garante isolamento em rerun)
    await pool.query(`DELETE FROM workers WHERE email LIKE '%@bidx-e2e.local'`);

    // Criar os 3 workers fixture
    [idGabriel, idMaria, idCarlos] = await Promise.all([
      createWorkerFixture(pool, kms, bidx, {
        firstName: 'Gabriel',
        lastName: 'Stein',
        email: 'gabriel.stein@bidx-e2e.local',
        phone: '5511990001001',
      }),
      createWorkerFixture(pool, kms, bidx, {
        firstName: 'Maria',
        lastName: 'José Silva',
        email: 'maria.silva@bidx-e2e.local',
        phone: '5511990001002',
      }),
      createWorkerFixture(pool, kms, bidx, {
        firstName: 'Carlos',
        lastName: 'Eduardo Santos',
        email: 'carlos.santos@bidx-e2e.local',
        phone: '5511990001003',
      }),
    ]);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM workers WHERE email LIKE '%@bidx-e2e.local'`);
      await pool.end();
    }
  });

  // ── Casos positivos ───────────────────────────────────────────────────────

  it('prefixo de sobrenome: "Gabriel Ste" encontra Gabriel Stein', async () => {
    const res = await api.get(
      '/api/admin/workers?search=Gabriel%20Ste&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
  });

  it('sobrenome completo: "Stein" encontra Gabriel Stein', async () => {
    const res = await api.get(
      '/api/admin/workers?search=Stein&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
  });

  it('primeiro nome: "Maria" encontra Maria José Silva', async () => {
    const res = await api.get(
      '/api/admin/workers?search=Maria&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('maria.silva@bidx-e2e.local');
  });

  it('substring no meio do token: "ari" encontra Maria José Silva', async () => {
    const res = await api.get(
      '/api/admin/workers?search=ari&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('maria.silva@bidx-e2e.local');
  });

  it('sufixo: "ein" encontra Gabriel Stein (sufixo de "Stein")', async () => {
    const res = await api.get(
      '/api/admin/workers?search=ein&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
  });

  it('acento normalizado: "jose" encontra Maria José Silva', async () => {
    const res = await api.get(
      '/api/admin/workers?search=jose&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('maria.silva@bidx-e2e.local');
  });

  it('multi-palavra exige todos os tokens: "Gabriel Stein" encontra Gabriel Stein', async () => {
    const res = await api.get(
      '/api/admin/workers?search=Gabriel%20Stein&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
  });

  it('busca case-insensitive: "GABRIEL" e "gabriel" retornam o mesmo worker', async () => {
    const [resUpper, resLower] = await Promise.all([
      api.get('/api/admin/workers?search=GABRIEL&limit=200', authHeaders(adminToken)),
      api.get('/api/admin/workers?search=gabriel&limit=200', authHeaders(adminToken)),
    ]);

    expect(resUpper.status).toBe(200);
    expect(resLower.status).toBe(200);

    const upperEmails = emails(resUpper);
    const lowerEmails = emails(resLower);

    expect(upperEmails).toContain('gabriel.stein@bidx-e2e.local');
    expect(lowerEmails).toContain('gabriel.stein@bidx-e2e.local');
    // Ambas as buscas retornam o mesmo conjunto (ao menos os fixtures)
    expect(upperEmails.sort()).toEqual(lowerEmails.sort());
  });

  // ── Casos negativos ───────────────────────────────────────────────────────

  it('tokens de workers diferentes: "Gabriel Maria" não retorna nenhum fixture', async () => {
    const res = await api.get(
      '/api/admin/workers?search=Gabriel%20Maria&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    const fixtureEmails = [
      'gabriel.stein@bidx-e2e.local',
      'maria.silva@bidx-e2e.local',
      'carlos.santos@bidx-e2e.local',
    ];
    const returned = emails(res);
    // Nenhum dos 3 fixtures deve aparecer (nenhum tem "gabriel" E "maria" no nome)
    for (const e of fixtureEmails) {
      expect(returned).not.toContain(e);
    }
  });

  it('termo inexistente: "Schultz" não retorna nenhum fixture', async () => {
    const res = await api.get(
      '/api/admin/workers?search=Schultz&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    const fixtureEmails = [
      'gabriel.stein@bidx-e2e.local',
      'maria.silva@bidx-e2e.local',
      'carlos.santos@bidx-e2e.local',
    ];
    const returned = emails(res);
    for (const e of fixtureEmails) {
      expect(returned).not.toContain(e);
    }
  });

  // ── Validação de input ────────────────────────────────────────────────────

  it('termo < 3 chars normalizados retorna 400', async () => {
    const res = await api.get(
      '/api/admin/workers?search=ab',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(400);
  });

  it('termo só com whitespace é tratado como sem filtro (200, sem 400)', async () => {
    const res = await api.get(
      '/api/admin/workers?search=%20%20%20',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('termo de 3 chars exatos é válido: "Gab" encontra Gabriel Stein', async () => {
    const res = await api.get(
      '/api/admin/workers?search=Gab&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
  });

  // ── Convivência com outros filtros ────────────────────────────────────────

  it('search + platform=enlite_app: retorna interseção', async () => {
    // Todos os fixtures foram inseridos sem data_sources → plataforma enlite_app
    const res = await api.get(
      '/api/admin/workers?search=Gabriel&platform=enlite_app&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
    // Nenhum resultado deve ser da plataforma talentum
    res.data.data.forEach((w: { platform: string }) => {
      expect(w.platform).not.toBe('talentum');
    });
  });

  it('busca por email continua funcionando (caminho ILIKE)', async () => {
    const res = await api.get(
      '/api/admin/workers?search=gabriel.stein@bidx-e2e.local&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
  });

  it('busca por telefone continua funcionando (caminho ILIKE)', async () => {
    const res = await api.get(
      '/api/admin/workers?search=5511990001001&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(emails(res)).toContain('gabriel.stein@bidx-e2e.local');
  });

  // Garantia de que os IDs retornados correspondem exatamente aos fixtures criados
  it('IDs retornados batem com os IDs inseridos diretamente no banco', async () => {
    expect(idGabriel).toBeTruthy();
    expect(idMaria).toBeTruthy();
    expect(idCarlos).toBeTruthy();

    const res = await api.get(
      '/api/admin/workers?search=Santos&limit=200',
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    const returnedIds = res.data.data.map((w: { id: string }) => w.id);
    expect(returnedIds).toContain(idCarlos);
  });
});
