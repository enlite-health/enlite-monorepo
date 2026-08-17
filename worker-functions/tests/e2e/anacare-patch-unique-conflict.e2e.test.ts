/**
 * anacare-patch-unique-conflict.e2e.test.ts
 *
 * E2E do conserto do PATCH com conflito de unicidade (worker JÁ linkado).
 *
 * Regressão medida em produção (11/08/2026): depois do #196 o espelho passou a
 * mandar o telefone em formato NACIONAL, o valor entrou no mesmo espaço dos
 * registros já nacionais do AnaCare e a unicidade deles passou a disparar no
 * PATCH — 9 falhas em 24h. Como `worker.mirror_requested` não tem retry, o
 * cadastro do worker congelava.
 *
 * Estratégia (mesma de anacare-continuous-sync.e2e.test.ts):
 *   - Servidor HTTP REAL no lugar do AnaCare (localhost:29997)
 *   - `fetch` real → `AnaCareClient` real → `AnaCareMirrorProvider` real
 *   - Banco real (enlite_e2e) + `MirrorWorkerService.mirrorOne` in-process
 *   - ZERO substituição por mock/spy do jest — nada do caminho é trocado
 *
 * Os corpos de 400 abaixo são LITERAIS de produção (strings de erro da API do
 * AnaCare, sem PII) — é o que o servidor deles devolve de verdade.
 *
 * O que é provado:
 *   1. 400 de telefone            → 2º PATCH SEM `telefono`, resto do cadastro vai
 *   2. 400 de email               → 2º PATCH SEM `email`
 *   3. 400 de telefone + email    → 2º PATCH sem os dois
 *   4. 400 `integrity_constraint` → NÃO retenta, propaga
 *   5. 400 com corpo não-JSON     → NÃO retenta, propaga
 *   6. `persistSuccess` zera `ana_care_sync_error` no sucesso do retry
 */

import http from 'http';
import { Pool } from 'pg';
import { MirrorWorkerService } from '../../src/modules/integration/application/MirrorWorkerService';
import { AnaCareMirrorProvider } from '../../src/modules/integration/infrastructure/anacare/AnaCareMirrorProvider';
import { AnaCareClient } from '../../src/modules/integration/infrastructure/anacare/AnaCareClient';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MOCK_PORT = 29997; // 29998 = continuous-sync, 29999 = backfill
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}`;

// ─── Corpos de 400 LITERAIS de produção ─────────────────────────────
// Strings de erro da API do AnaCare (não contêm PII — nem número, nem email).

const BODY_400_TELEFONO =
  '{"telefono":["No es posible usar este número de teléfono para el registro."]}';
const BODY_400_EMAIL =
  '{"email":["No es posible usar este correo electrónico para el registro."]}';
const BODY_400_TELEFONO_E_EMAIL =
  '{"telefono":["No es posible usar este número de teléfono para el registro."],"email":["No es posible usar este correo electrónico para el registro."]}';
const BODY_400_INTEGRITY_CONSTRAINT =
  '{"message":"integrity_constraint","message_client":"Algo salió mal..."}';
// 400 que NÃO é JSON — proxy/WAF respondendo HTML no lugar da API.
const BODY_400_NAO_JSON =
  '<html><head><title>400 Bad Request</title></head><body><h1>400 Bad Request</h1></body></html>';

// ─── Servidor HTTP no lugar do AnaCare ──────────────────────────────

interface PatchAttempt {
  nurseId: number;
  body: Record<string, unknown>;
}

interface CannedFailure {
  contentType: string;
  body: string;
}

interface MockState {
  /** Todo PATCH que chegou, na ordem — é o que as asserções leem. */
  patchAttempts: PatchAttempt[];
  /** Fila de 400 por nurseId; esgotada a fila, o servidor responde 200. */
  failuresByNurseId: Map<number, CannedFailure[]>;
}

function createAnaCareServer(state: MockState): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      if (req.url === '/api/v2/agencies/nurse-types/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 1, name: 'Acompañante Terapéutico' }],
          }),
        );
        return;
      }
      if (req.url === '/api/v2/agencies/hiring-types/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
        return;
      }

      const patchMatch = req.url?.match(/^\/api\/v2\/agencies\/nurses\/(\d+)\/$/) ?? null;
      if (patchMatch && req.method === 'PATCH') {
        const nurseId = parseInt(patchMatch[1], 10);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        state.patchAttempts.push({ nurseId, body });

        const queued = state.failuresByNurseId.get(nurseId);
        const failure = queued?.shift();
        if (failure) {
          res.writeHead(400, { 'Content-Type': failure.contentType });
          res.end(failure.body);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: nurseId,
            nombre: body.nombre ?? 'updated',
            apellidos: body.apellidos ?? 'updated',
            genero: body.genero ?? 'M',
            email: body.email ?? 'u@e.com',
          }),
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'not found' }));
    });
  });
}

// ─── Suite ──────────────────────────────────────────────────────────

describe('AnaCare PATCH — conflito de unicidade (worker já linkado)', () => {
  let pool: Pool;
  let mockServer: http.Server;
  let state: MockState;
  let service: MirrorWorkerService;

  const workerIds: string[] = [];

  /** Os campos PII são base64 no e2e: KMSEncryptionService entra em passthrough com NODE_ENV=test. */
  const enc = (v: string): string => Buffer.from(v, 'utf8').toString('base64');

  beforeAll(async () => {
    state = { patchAttempts: [], failuresByNurseId: new Map() };
    mockServer = createAnaCareServer(state);
    await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, resolve));

    process.env.ANACARE_API_KEY = 'ana_care.test.patch-conflict';
    process.env.ANACARE_BASE_URL = MOCK_BASE_URL;

    pool = new Pool({ connectionString: DATABASE_URL });
    service = new MirrorWorkerService(new AnaCareMirrorProvider(AnaCareClient.fromEnv()));
  });

  afterAll(async () => {
    if (workerIds.length > 0) {
      await pool
        .query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1::uuid[])`, [workerIds])
        .catch(() => {});
      await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [workerIds]).catch(() => {});
    }
    await pool.end().catch(() => {});
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    delete process.env.ANACARE_API_KEY;
    delete process.env.ANACARE_BASE_URL;
  });

  beforeEach(() => {
    state.patchAttempts.length = 0;
    state.failuresByNurseId.clear();
  });

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Worker REGISTERED, já linkado (ana_care_id preenchido), com um erro de sync
   * ANTERIOR gravado — para provar que o sucesso do retry o limpa.
   */
  async function insertLinkedWorker(opts: {
    slug: string;
    anaCareId: number;
    phone: string;
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (
         auth_uid, email, status, country, phone, occupation,
         first_name_encrypted, last_name_encrypted, sex_encrypted,
         ana_care_id, ana_care_sync_error
       )
       VALUES ($1, $2, 'REGISTERED', 'AR', $3, 'AT', $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        `apuc-${opts.slug}`,
        `apuc-${opts.slug}@example.com`,
        opts.phone,
        enc('Carina'),
        enc('Fixture'),
        enc('FEMALE'),
        String(opts.anaCareId),
        'erro anterior — deve ser limpo pelo persistSuccess',
      ],
    );
    const id = rows[0].id;
    workerIds.push(id);
    return id;
  }

  function attemptsFor(nurseId: number): PatchAttempt[] {
    return state.patchAttempts.filter((a) => a.nurseId === nurseId);
  }

  async function syncStateOf(workerId: string): Promise<{
    ana_care_id: string | null;
    ana_care_sync_error: string | null;
    ana_care_synced_at: Date | null;
  }> {
    const { rows } = await pool.query(
      `SELECT ana_care_id, ana_care_sync_error, ana_care_synced_at FROM workers WHERE id = $1`,
      [workerId],
    );
    return rows[0];
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. 400 de telefone → reenvia sem telefone, resto do cadastro vai
  // ═══════════════════════════════════════════════════════════════

  it('400 de telefone (corpo literal de prod) → 2º PATCH SEM telefono, resto do cadastro sincroniza', async () => {
    const anaCareId = 29701;
    const workerId = await insertLinkedWorker({
      slug: 'telefono',
      anaCareId,
      phone: '5491155550001',
    });
    state.failuresByNurseId.set(anaCareId, [
      { contentType: 'application/json', body: BODY_400_TELEFONO },
    ]);

    const result = await service.mirrorOne(workerId);

    expect(result).toBe('updated');

    const attempts = attemptsFor(anaCareId);
    expect(attempts).toHaveLength(2);
    // 1ª tentativa: payload completo, com o telefone nacional (o que dispara o 400)
    expect(attempts[0].body).toHaveProperty('telefono', '1155550001');
    // 2ª tentativa: sem o campo em conflito…
    expect(attempts[1].body).not.toHaveProperty('telefono');
    // …e com TODO o resto do cadastro — é o ponto do conserto
    expect(attempts[1].body).toMatchObject({
      nombre: 'Carina',
      apellidos: 'Fixture',
      genero: 'M',
      email: `apuc-telefono@example.com`,
      tipo_enfermera: 1,
    });

    // persistSuccess: o erro anterior é apagado e o carimbo de sync é gravado
    const after = await syncStateOf(workerId);
    expect(after.ana_care_sync_error).toBeNull();
    expect(after.ana_care_synced_at).not.toBeNull();
    expect(after.ana_care_id).toBe(String(anaCareId));
  });

  // ═══════════════════════════════════════════════════════════════
  // 2. 400 de email
  // ═══════════════════════════════════════════════════════════════

  it('400 de email (corpo literal de prod) → 2º PATCH SEM email, resto do cadastro sincroniza', async () => {
    const anaCareId = 29702;
    const workerId = await insertLinkedWorker({
      slug: 'email',
      anaCareId,
      phone: '5491155550002',
    });
    state.failuresByNurseId.set(anaCareId, [
      { contentType: 'application/json', body: BODY_400_EMAIL },
    ]);

    const result = await service.mirrorOne(workerId);

    expect(result).toBe('updated');

    const attempts = attemptsFor(anaCareId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].body).toHaveProperty('email', 'apuc-email@example.com');
    expect(attempts[1].body).not.toHaveProperty('email');
    expect(attempts[1].body).toMatchObject({
      nombre: 'Carina',
      telefono: '1155550002',
    });

    expect((await syncStateOf(workerId)).ana_care_sync_error).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════
  // 3. 400 de telefone + email → tira os dois
  // ═══════════════════════════════════════════════════════════════

  it('400 de telefone E email (corpo literal de prod) → 2º PATCH sem os dois', async () => {
    const anaCareId = 29703;
    const workerId = await insertLinkedWorker({
      slug: 'ambos',
      anaCareId,
      phone: '5491155550003',
    });
    state.failuresByNurseId.set(anaCareId, [
      { contentType: 'application/json', body: BODY_400_TELEFONO_E_EMAIL },
    ]);

    const result = await service.mirrorOne(workerId);

    expect(result).toBe('updated');

    const attempts = attemptsFor(anaCareId);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].body).not.toHaveProperty('telefono');
    expect(attempts[1].body).not.toHaveProperty('email');
    expect(attempts[1].body).toMatchObject({
      nombre: 'Carina',
      apellidos: 'Fixture',
      genero: 'M',
      tipo_enfermera: 1,
    });

    expect((await syncStateOf(workerId)).ana_care_sync_error).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════
  // 4. 400 que NÃO é de unicidade → não retenta, propaga
  // ═══════════════════════════════════════════════════════════════

  it('400 integrity_constraint (outra forma real de prod) → NÃO retenta e o erro propaga', async () => {
    const anaCareId = 29704;
    const workerId = await insertLinkedWorker({
      slug: 'integrity',
      anaCareId,
      phone: '5491155550004',
    });
    // duas respostas na fila: se houvesse retry indevido, a 2ª seria consumida
    state.failuresByNurseId.set(anaCareId, [
      { contentType: 'application/json', body: BODY_400_INTEGRITY_CONSTRAINT },
      { contentType: 'application/json', body: BODY_400_INTEGRITY_CONSTRAINT },
    ]);

    await expect(service.mirrorOne(workerId)).rejects.toThrow(/integrity_constraint/);

    expect(attemptsFor(anaCareId)).toHaveLength(1);

    // o erro é persistido (não some em silêncio) e o worker NÃO ganha carimbo de sync
    const after = await syncStateOf(workerId);
    expect(after.ana_care_sync_error).toContain('integrity_constraint');
    expect(after.ana_care_synced_at).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════
  // 5. 400 com corpo não-JSON (proxy/WAF) → não retenta, propaga
  // ═══════════════════════════════════════════════════════════════

  it('400 com corpo NÃO-JSON (HTML de proxy) → NÃO retenta e o erro propaga', async () => {
    const anaCareId = 29705;
    const workerId = await insertLinkedWorker({
      slug: 'html',
      anaCareId,
      phone: '5491155550005',
    });
    state.failuresByNurseId.set(anaCareId, [
      { contentType: 'text/html', body: BODY_400_NAO_JSON },
      { contentType: 'text/html', body: BODY_400_NAO_JSON },
    ]);

    await expect(service.mirrorOne(workerId)).rejects.toThrow(/HTTP 400/);

    expect(attemptsFor(anaCareId)).toHaveLength(1);

    const after = await syncStateOf(workerId);
    expect(after.ana_care_sync_error).toContain('400');
    expect(after.ana_care_synced_at).toBeNull();
  });
});
