/**
 * talentum-link-fora-das-rotas-publicas-067.e2e.test.ts — spec 067 F5 (FR-14..17, A7, A8 iii, A12), banco REAL, Express em processo.
 *
 * O link do pré-screening da Talentum NÃO sai mais das duas rotas públicas (`GET /api/public/v1/jobs`, `GET /api/vacancies/:id`):
 * elas devolvem só `can_apply`. O link chega ao front SÓ no 200 de `POST /api/worker-applications/track-channel` (e à Luz só no
 * `ok:true` da capability) — a 403 / `ok:false` nunca o carregam. A postulação segue no limiar "enviado" (A12): prestador
 * REGISTERED com documento enviado e NÃO validado postula.
 *
 * Outbound mapeado (plan §6): as duas rotas públicas só LEEM. track-channel e a capability gravam WJA/encuadre/tentativa barrada no
 * banco e NÃO falam com a Talentum, com short link nem com WhatsApp — quem abre o link é o FRONT (aqui o link é só uma string local
 * não roteável: `http://talentum.invalid/...`; o teste lê o corpo da resposta, nunca abre nada). Sem Pub/Sub, sem canal real.
 * Dados SINTÉTICOS (@example.test / .invalid), sem PII em asserção.
 */
import { Pool } from 'pg';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { completeWorkerProfile, cleanWorkerProfile } from './helpers/aptoWorkerFixture';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const RUN = Date.now().toString(36);
const ID = {
  patient: 'a0670000-0000-4000-c001-000000000001',
  vagaLink: 'a0670000-0000-4000-c002-000000000001', // v2 web: /public/pre-screening/
  vagaWaMe: 'a0670000-0000-4000-c002-000000000002', // legado: wa.me
  vagaSemLink: 'a0670000-0000-4000-c002-000000000003',
  enviadoNaoValidado: 'a0670000-0000-4000-c003-000000000001',
  incompleto: 'a0670000-0000-4000-c003-000000000002',
};
const WORKERS = [ID.enviadoNaoValidado, ID.incompleto];
const LINK_V2 = `http://talentum.invalid/public/pre-screening/c0670000-0000-4000-8000-${RUN.padStart(12, '0').slice(-12)}/chat`;
const LINK_WA = `https://wa.me/5491100000000?text=067-${RUN}`;
const FORBIDDEN_IN_PUBLIC = [LINK_V2, LINK_WA, 'wa.me', '/public/pre-screening/', 'talentum_whatsapp_url', 'whatsapp_url', 'prescreeningUrl'];

let pool: Pool;
let server: Server;
let baseUrl: string;

async function limpar(): Promise<void> {
  const jobs = [ID.vagaLink, ID.vagaWaMe, ID.vagaSemLink];
  await pool.query(`DELETE FROM worker_blocked_applications WHERE job_posting_id = ANY($1::uuid[])`, [jobs]).catch(() => undefined);
  await pool.query(`DELETE FROM encuadres WHERE job_posting_id = ANY($1::uuid[])`, [jobs]);
  await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1::uuid[])`, [jobs]);
  await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [jobs]);
  await cleanWorkerProfile(pool, WORKERS);
  await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`, [WORKERS]).catch(() => undefined);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKERS]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [ID.patient]);
}

async function semearVaga(id: string, caseNumber: number, link: string | null): Promise<void> {
  const { rows } = await pool.query<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status, is_draft, is_test,
                               talentum_whatsapp_url, social_short_links)
     VALUES ($1, $2, $3, $4, $5, '', 'AR', 'SEARCHING', false, false, $6, '{"site": "https://enl.example.test/x"}'::jsonb)`,
    [id, parseInt(rows[0].vn, 10), caseNumber, ID.patient, `067-link-${RUN}-${caseNumber}`, link],
  );
}

async function get(path: string): Promise<{ status: number; texto: string; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const texto = await res.text();
  return { status: res.status, texto, body: JSON.parse(texto) };
}

async function track(authUid: string, jobPostingId: string): Promise<{ status: number; texto: string; body: any }> {
  const res = await fetch(`${baseUrl}/__track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-uid': authUid },
    body: JSON.stringify({ jobPostingId, channel: 'site' }),
  });
  const texto = await res.text();
  return { status: res.status, texto, body: JSON.parse(texto) };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  await limpar();
  await pool.query(`INSERT INTO patients (id, clickup_task_id, country, first_name, last_name) VALUES ($1, 'link-067', 'AR', 'Ficticia', 'Teste')`, [ID.patient]);
  await semearVaga(ID.vagaLink, 99067101, LINK_V2);
  await semearVaga(ID.vagaWaMe, 99067102, LINK_WA);
  await semearVaga(ID.vagaSemLink, 99067103, null);
  for (const [tag, id] of [['enviado', ID.enviadoNaoValidado], ['incompleto', ID.incompleto]] as const) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, status, country, timezone) VALUES ($1, $2, $3, $4, 'AR', 'America/Argentina/Buenos_Aires')`,
      [id, `uid-link-067-${tag}-${RUN}`, `link-067-${tag}-${RUN}@example.test`, tag === 'enviado' ? 'REGISTERED' : 'INCOMPLETE_REGISTER'],
    );
  }
  // REGISTERED com documento ENVIADO e NÃO validado (A12): postula, mas NÃO é apto.
  await completeWorkerProfile(pool, ID.enviadoNaoValidado, 'unvalidated');

  const express = (await import('express')).default;
  const { PublicJobsController, PublicVacancyController, WorkerApplicationsController } = await import('@modules/matching');
  const app = express();
  app.use(express.json());
  const jobs = new PublicJobsController();
  const vacancy = new PublicVacancyController();
  const apply = new WorkerApplicationsController();
  app.get('/api/public/v1/jobs', (req, res) => { void jobs.listActiveJobs(req, res); });
  app.get('/api/vacancies/:id', (req, res) => { void vacancy.getById(req, res); });
  app.post('/__track', (req, res) => {
    (req as any).user = { uid: String(req.headers['x-test-uid']) };
    void apply.trackChannel(req, res);
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await limpar();
  await pool.end();
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().getPool().end().catch(() => undefined);
});

describe('o link da Talentum fora das rotas públicas (spec 067 FR-14..17)', () => {
  it('controle (sabe dizer "tem"): o link semeado EXISTE no banco para as duas vagas com link', async () => {
    const { rows } = await pool.query(`SELECT id, talentum_whatsapp_url AS url FROM job_postings WHERE id = ANY($1::uuid[]) ORDER BY id`, [[ID.vagaLink, ID.vagaWaMe]]);
    expect(rows.map((r) => r.url)).toEqual([LINK_V2, LINK_WA]);
  });

  it('A7/A8 iii — GET /api/public/v1/jobs: nenhum link nem campo antigo no corpo; can_apply true com link, false sem', async () => {
    const r = await get('/api/public/v1/jobs?country=AR');
    expect(r.status).toBe(200);
    const byId = new Map<string, any>((r.body.data as any[]).map((j) => [j.id, j]));
    for (const id of [ID.vagaLink, ID.vagaWaMe, ID.vagaSemLink]) expect(byId.has(id)).toBe(true); // controle: as 3 vagas estão no feed
    expect(byId.get(ID.vagaLink).can_apply).toBe(true);
    expect(byId.get(ID.vagaWaMe).can_apply).toBe(true);
    expect(byId.get(ID.vagaSemLink).can_apply).toBe(false);
    for (const proibido of FORBIDDEN_IN_PUBLIC) expect(r.texto).not.toContain(proibido);
    for (const item of r.body.data as any[]) expect(Object.keys(item)).not.toContain('whatsapp_url');
  });

  it('A7/A8 iii — GET /api/vacancies/:id: nenhum link nem campo antigo; can_apply reflete a presença do link', async () => {
    for (const [id, esperado] of [[ID.vagaLink, true], [ID.vagaWaMe, true], [ID.vagaSemLink, false]] as const) {
      const r = await get(`/api/vacancies/${id}`);
      expect(r.status).toBe(200);
      expect(r.body.data.can_apply).toBe(esperado);
      expect(Object.keys(r.body.data)).not.toContain('talentum_whatsapp_url');
      for (const proibido of FORBIDDEN_IN_PUBLIC) expect(r.texto).not.toContain(proibido);
    }
  });
});

describe('o link só na postulação aprovada (spec 067 FR-16, A7, A12)', () => {
  it('A12 — REGISTERED com documento ENVIADO e NÃO validado postula: 200 + prescreeningUrl (v2 e wa.me); sem link na vaga → null', async () => {
    const dono = await pool.query(`SELECT fn_worker_is_apto(id) AS apto, status FROM workers WHERE id = $1`, [ID.enviadoNaoValidado]);
    expect(dono.rows[0]).toEqual({ apto: false, status: 'REGISTERED' }); // controle: NÃO é apto e mesmo assim postula

    const uid = `uid-link-067-enviado-${RUN}`;
    const a = await track(uid, ID.vagaLink);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ success: true, data: { prescreeningUrl: LINK_V2 } });

    const b = await track(uid, ID.vagaWaMe);
    expect(b.status).toBe(200);
    expect(b.body.data.prescreeningUrl).toBe(LINK_WA);

    const c = await track(uid, ID.vagaSemLink);
    expect(c.status).toBe(200);
    expect(c.body.data.prescreeningUrl).toBeNull();

    const wja = await pool.query(`SELECT count(*)::int AS n FROM worker_job_applications WHERE worker_id = $1`, [ID.enviadoNaoValidado]);
    expect(wja.rows[0].n).toBe(3);
  });

  it('A7 — prestador INCOMPLETE_REGISTER: 403 WORKER_NOT_ELIGIBLE e o corpo NÃO traz o link nem o campo', async () => {
    const r = await track(`uid-link-067-incompleto-${RUN}`, ID.vagaLink);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ success: false, code: 'WORKER_NOT_ELIGIBLE', reason: 'registration_incomplete' });
    for (const proibido of [LINK_V2, 'prescreeningUrl', '/public/pre-screening/', 'wa.me']) expect(r.texto).not.toContain(proibido);
  });

  it('A7 (Luz) — a capability devolve o link só no ok:true; o ok:false nunca o leva', async () => {
    const { ApplyToVacancyUseCase } = await import('../../src/modules/matching/application/ApplyToVacancyUseCase');
    const { WorkerApplicationRegisterCapability } = await import('../../src/modules/mcp/application/capabilities/WorkerApplicationRegisterCapability');
    const cap = new WorkerApplicationRegisterCapability(
      new ApplyToVacancyUseCase(),
      pool,
      { execute: async () => { throw new Error('sem auditoria de nome neste teste'); } } as never,
    );

    const ok = await cap.execute({ workerId: ID.enviadoNaoValidado, jobPostingId: ID.vagaLink });
    expect(ok).toMatchObject({ ok: true, prescreeningUrl: LINK_V2 });

    const barrado = await cap.execute({ workerId: ID.incompleto, jobPostingId: ID.vagaLink });
    expect(barrado.ok).toBe(false);
    expect(JSON.stringify(barrado)).not.toContain('prescreeningUrl');
    expect(JSON.stringify(barrado)).not.toContain(LINK_V2);
  });
});
