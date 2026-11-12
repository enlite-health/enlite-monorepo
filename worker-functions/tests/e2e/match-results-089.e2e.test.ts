/**
 * match-results-089.e2e.test.ts — spec 089 T011 (CA-1, CA-2, CA-4) pela borda: API real + Postgres real.
 *
 * GET /api/admin/vacancies/:id/match-results devolve UMA linha por prestador (área viva mais próxima do serviço), com lat/lng da
 * MESMA área, `service`, meta (`invitedCount`, `pendingInVacancyCount`, `operationDate`), ordem por distância e `limit=0` só meta.
 *
 * Esta rota NÃO envia mensagem (só SELECT): nenhum canal externo é tocado. Dados 100% sintéticos, sem PII.
 * Molde: `match-results.test.ts` (axios contra a API do stack + `pg` para semear), token via `getMockToken`.
 */
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const STAMP = `m089-${Date.now()}`;

// Serviço em Buenos Aires; áreas ao norte (1° de latitude ≈ 111,19 km).
const SERVICE = { lat: -34.6037, lng: -58.3816 };
const KM = 1 / 111.19;
const north = (km: number) => ({ lat: SERVICE.lat + km * KM, lng: SERVICE.lng });

const arDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(d);

describe('GET match-results — spec 089 (uma linha por prestador, área mais próxima) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let token: string;
  let seq = 0;

  const jobIds: string[] = [];
  const workerIds: string[] = [];
  const patientIds: string[] = [];

  const headers = () => ({ headers: { Authorization: `Bearer ${token}` } });
  const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T> =>
    (await pool.query(sql, params)).rows[0] as T;
  const get = (jobId: string, qs = '') => api.get(`/api/admin/vacancies/${jobId}/match-results${qs}`, headers());

  async function patient(): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'M089', 'E2E', 'AR', 'ACTIVE') RETURNING id`,
      [`${STAMP}-p${++seq}`],
    );
    patientIds.push(r.id);
    return r.id;
  }

  /** Vacante com endereço do serviço. `point = null` → endereço sem coordenada; `address = false` → sem patient_address_id. */
  async function vacancy(point: { lat: number; lng: number } | null, address = true): Promise<string> {
    const patientId = await patient();
    const { vn } = await one<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
    const job = await one<{ id: string }>(
      `INSERT INTO job_postings (vacancy_number, patient_id, title, description, country, status, is_draft, is_test)
       VALUES ($1, $2, $3, '', 'AR', 'SEARCHING', false, false) RETURNING id`,
      [parseInt(vn, 10), patientId, `${STAMP}-v${++seq}`],
    );
    jobIds.push(job.id);
    if (address) {
      const addr = await one<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, lat, lng)
         VALUES ($1, 'domicilio_propio', 'Calle Sintetica 123, CABA', $2, $3) RETURNING id`,
        [patientId, point?.lat ?? null, point?.lng ?? null],
      );
      await pool.query('UPDATE job_postings SET patient_address_id = $1 WHERE id = $2', [addr.id, job.id]);
    }
    return job.id;
  }

  /** Prestador com N áreas vivas (km ao norte do serviço) e uma candidatura. */
  async function worker(opts: {
    jobId: string; areasKm: number[]; source?: string; stage?: string; messagedAt?: Date | null; response?: string | null;
  }): Promise<string> {
    const w = await one<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, country, timezone, status) VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED') RETURNING id`,
      [`${STAMP}-uid-${++seq}`, `${STAMP}-${seq}@m089.test`],
    );
    workerIds.push(w.id);
    for (const km of opts.areasKm) {
      const p = north(km);
      await pool.query(
        `INSERT INTO worker_service_areas (worker_id, latitude, longitude, radius_km, work_zone) VALUES ($1, $2, $3, 10, $4)`,
        [w.id, p.lat, p.lng, `zona-${km}km`],
      );
    }
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, messaged_at, interview_response)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [w.id, opts.jobId, opts.stage ?? 'INVITED', opts.source ?? 'system', opts.messagedAt ?? null, opts.response ?? null],
    );
    return w.id;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    token = await getMockToken(api, { uid: `${STAMP}-admin`, email: `${STAMP}-admin@e2e.local`, role: 'admin' });
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM job_postings WHERE id = ANY($1::uuid[])', [jobIds]).catch(() => {});
    await pool.query('DELETE FROM workers WHERE id = ANY($1::uuid[])', [workerIds]).catch(() => {});
    await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [patientIds]).catch(() => {});
    await pool.end();
  });

  describe('vacante completa (7 prestadores)', () => {
    let jobId: string;
    const w: Record<string, string> = {};

    beforeAll(async () => {
      jobId = await vacancy(SERVICE);
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
      w.twoAreas  = await worker({ jobId, areasKm: [30, 2] });            // 2 áreas: 2 km e 30 km
      w.five      = await worker({ jobId, areasKm: [5] });
      w.eight     = await worker({ jobId, areasKm: [8] });
      w.manual    = await worker({ jobId, areasKm: [12], source: 'manual' }); // manual INVITED sem messaged_at → pendente
      w.previous  = await worker({ jobId, areasKm: [15] });                // system de match anterior → NÃO é pendente
      w.invited   = await worker({ jobId, areasKm: [20], messagedAt: yesterday }); // já convidado ontem
      w.noArea    = await worker({ jobId, areasKm: [] });                  // sem área → distância null, por último
      await pool.query(`INSERT INTO worker_documents (worker_id, documents_status) VALUES ($1, 'approved')`, [w.twoAreas]);
    });

    it('CA-1: prestador com 2 áreas aparece 1x, distanceKm≈2.0 e lat/lng da área de 2 km (não a de 30 km)', async () => {
      const res = await get(jobId);
      expect(res.status).toBe(200);
      const rows = res.data.data.candidates.filter((c: any) => c.workerId === w.twoAreas);
      expect(rows).toHaveLength(1);
      expect(rows[0].distanceKm).toBeGreaterThanOrEqual(1.9);
      expect(rows[0].distanceKm).toBeLessThanOrEqual(2.1);
      expect(rows[0].lat).toBeCloseTo(north(2).lat, 5);
      expect(rows[0].lng).toBeCloseTo(north(2).lng, 5);
      expect(rows[0].workZone).toBe('zona-2km');
      expect(rows[0].documentStatus).toBe('approved');
      expect(res.data.data.candidates).toHaveLength(7);
      expect(res.data.data.totalCandidates).toBe(7); // pessoas distintas
    });

    it('CA-4: ordem distance_km ASC NULLS LAST; sem área vem por último com distância/lat/lng null', async () => {
      const res = await get(jobId);
      const order = res.data.data.candidates.map((c: any) => c.workerId);
      expect(order).toEqual([w.twoAreas, w.five, w.eight, w.manual, w.previous, w.invited, w.noArea]);
      const last = res.data.data.candidates[6];
      expect(last.distanceKm).toBeNull();
      expect(last.lat).toBeNull();
      expect(last.lng).toBeNull();
    });

    it('campos novos por candidato: source, funnelStage, replied, messagedAt, workerStatus', async () => {
      const res = await get(jobId);
      const by = (id: string) => res.data.data.candidates.find((c: any) => c.workerId === id);
      expect(by(w.manual)).toMatchObject({ source: 'manual', funnelStage: 'INVITED', replied: false, messagedAt: null });
      expect(by(w.previous)).toMatchObject({ source: 'system', funnelStage: 'INVITED', replied: false });
      expect(by(w.invited).messagedAt).not.toBeNull();
      expect(by(w.invited).alreadyApplied).toBe(true);
      expect(by(w.five)).toHaveProperty('workerStatus');
      expect(by(w.five)).not.toHaveProperty('overallStatus');
    });

    it('CA-2: service {lat,lng,addressLabel} e meta batem com o seed', async () => {
      const before = arDay(new Date());
      const res = await get(jobId);
      const after = arDay(new Date());
      const d = res.data.data;
      expect(d.service.lat).toBeCloseTo(SERVICE.lat, 5);
      expect(d.service.lng).toBeCloseTo(SERVICE.lng, 5);
      expect(d.service.addressLabel).toBe('Calle Sintetica 123, CABA');
      expect(d.invitedCount).toBe(1);               // só o convidado ontem (messaged_at)
      expect(d.pendingInVacancyCount).toBe(1);      // só o manual INVITED sem messaged_at e sem resposta
      expect([before, after]).toContain(d.operationDate); // dia local de Buenos Aires
      expect(d.operationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('manual que já respondeu não é pendente', async () => {
      const job2 = await vacancy(SERVICE);
      await worker({ jobId: job2, areasKm: [3], source: 'manual' });
      await worker({ jobId: job2, areasKm: [4], source: 'manual', response: 'confirmed' });
      const res = await get(job2);
      expect(res.data.data.pendingInVacancyCount).toBe(1);
      expect(res.data.data.candidates.find((c: any) => c.replied === true)).toBeDefined();
    });

    it('limit=0 é válido: candidates [] e meta preenchida', async () => {
      const res = await get(jobId, '?limit=0');
      expect(res.status).toBe(200);
      expect(res.data.data.candidates).toEqual([]);
      expect(res.data.data.totalCandidates).toBe(7);
      expect(res.data.data.invitedCount).toBe(1);
      expect(res.data.data.pendingInVacancyCount).toBe(1);
      expect(res.data.data.service.lat).toBeCloseTo(SERVICE.lat, 5);
    });

    it('SUP-1: worker_documents é UNIQUE(worker_id) no banco — 2ª linha é rejeitada (a LATERAL LIMIT 1 é cinto e suspensório)', async () => {
      await expect(
        pool.query(`INSERT INTO worker_documents (worker_id, documents_status) VALUES ($1, 'pending')`, [w.twoAreas]),
      ).rejects.toThrow(/worker_documents_worker_id_key/);
      const res = await get(jobId);
      expect(res.data.data.candidates.filter((c: any) => c.workerId === w.twoAreas)).toHaveLength(1);
    });

    it('limit acima do teto é cortado em 500 (aceito, não erro)', async () => {
      const res = await get(jobId, '?limit=100000');
      expect(res.status).toBe(200);
      expect(res.data.data.candidates).toHaveLength(7);
    });
  });

  describe('LIMIT conta pessoas, não linhas (CA-1)', () => {
    it('limit=2 com 3 prestadores (1 com 2 áreas) devolve 2 pessoas distintas', async () => {
      const jobId = await vacancy(SERVICE);
      const dup = await worker({ jobId, areasKm: [1, 4] }); // 2ª área ANTES do próximo prestador: no JOIN cru o LIMIT 2 repetiria a pessoa
      const b = await worker({ jobId, areasKm: [6] });
      await worker({ jobId, areasKm: [9] });
      const res = await get(jobId, '?limit=2');
      const ids = res.data.data.candidates.map((c: any) => c.workerId);
      expect(ids).toEqual([dup, b]);
      expect(new Set(ids).size).toBe(2);
      expect(res.data.data.totalCandidates).toBe(3);
    });

    it('offset pagina pessoas distintas sem repetir', async () => {
      const jobId = await vacancy(SERVICE);
      const dup = await worker({ jobId, areasKm: [1, 4] });
      const b = await worker({ jobId, areasKm: [6] });
      const c = await worker({ jobId, areasKm: [9] });
      const p1 = (await get(jobId, '?limit=2&offset=0')).data.data.candidates.map((x: any) => x.workerId);
      const p2 = (await get(jobId, '?limit=2&offset=2')).data.data.candidates.map((x: any) => x.workerId);
      expect([...p1, ...p2]).toEqual([dup, b, c]);
    });
  });

  describe('serviço sem coordenada (CA-2)', () => {
    it('endereço sem lat/lng: service.lat/lng === null (nunca 0); candidatos seguem, ordem estável por worker_id', async () => {
      const jobId = await vacancy(null);
      const a = await worker({ jobId, areasKm: [2] });
      const b = await worker({ jobId, areasKm: [3] });
      const res = await get(jobId);
      expect(res.status).toBe(200);
      expect(res.data.data.service.lat).toBeNull();
      expect(res.data.data.service.lng).toBeNull();
      expect(res.data.data.service.addressLabel).toBe('Calle Sintetica 123, CABA');
      const rows = res.data.data.candidates;
      expect(rows.map((c: any) => c.workerId)).toEqual([a, b].sort());
      rows.forEach((c: any) => {
        expect(c.distanceKm).toBeNull();
        expect(c.lat).not.toBeNull(); // pino do prestador existe; só a distância é desconhecida
      });
    });

    it('vacante sem patient_address_id: service todo null', async () => {
      const jobId = await vacancy(null, false);
      const res = await get(jobId);
      expect(res.status).toBe(200);
      expect(res.data.data.service).toEqual({ lat: null, lng: null, addressLabel: null });
    });
  });

  describe('permissão inalterada', () => {
    it('401 sem token', async () => {
      const res = await api.get('/api/admin/vacancies/00000000-0000-0000-0000-000000000000/match-results');
      expect(res.status).toBe(401);
    });
  });
});
