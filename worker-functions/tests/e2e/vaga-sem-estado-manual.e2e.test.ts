/**
 * vaga-sem-estado-manual.e2e.test.ts @integration — semaforo-da-vaga F4 (back): sai o estado manual da vaga e "publicável" ganha dono
 * (`matching/domain/vacancyPublication.ts`).
 *
 * API real (container) + Postgres real. Nenhum canal real: o Talentum é o STUB local (`TalentumV2Stub`, porta 9914, `TALENTUM_API_BASE_URL` do
 * docker-compose.test.yml) e o Short.io é o STUB novo (`ShortIoStub`, porta 9915, `SHORT_IO_BASE_URL`). Vertex nunca é chamado: a vaga já nasce com
 * `talentum_description`. Massa sintética (paciente sobrenome " QA", prefixo `semaforo-f4`), apagada no afterAll com contagem 0.
 *
 * Os 7 casos de fase-4.md §8 + o 8º (a Luz, decisão 1 do plano):
 *   (i)    vaga nova → publish no Talentum → aparece no feed público, na busca por raio do app e na página pública, com short link pedido
 *          ao stub — sem NENHUM PUT de status (a vaga segue PENDING_ACTIVATION no banco);
 *   (ii)   ATAQUE: PUT status SEARCHING → 400 com as 2 mensagens, banco intacto;
 *   (iii)  idem ON_HOLD e CLOSED, e POST com status (nenhuma vaga criada);
 *   (iv)   paciente pausado pela ação humana → a vaga some do feed e o Talentum recebe PUT pause (via PENDING_PAUSE, na mesma transação);
 *          retomar → volta e o Talentum recebe PUT resume; MANUAL_PAUSE e DE_BAJA nunca são retomados;
 *   (v)    linha legada ON_HOLD com is_draft=false → fora do feed e lifecycle = null (D6, opção A);
 *   (vi)   POST /vacancies/baja de vaga sem serviço → DE_BAJA, fora do feed, página pública 200 com is_disabled;
 *   (vii)  vaga de serviço → baixa recusada com a mensagem nova (P8);
 *   (viii) a Luz ("vagas próximas") oferece o que o feed oferece: uma vaga de paciente SUSPENDED não aparece;
 *   (ix)   P6: vaga lançada com o paciente pausado não ganha link; a retomada do paciente garante o short link e a vaga volta ao feed;
 *   (x)    I1: publish com o paciente JÁ pausado → a vaga nasce PENDING_PAUSE na transação e o Talentum recebe PUT pause (fora do feed);
 *   (xi)   I3: a pausa que o Talentum recusa (403) vira MANUAL_PAUSE; o paciente retoma → PENDING_RESUME → PUT resume, e sai da lista manual;
 *   (xii)  I4: a candidatura (app) decide pelo dono de publicável: paciente SUSPENDED → 409 VACANCY_NOT_PUBLISHABLE, nenhuma candidatura criada;
 *   (xiii) B3b: vaga `is_test` publicável abre na página pública (200) e aceita candidatura, e NÃO aparece no feed nem na busca por raio.
 */
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import {
  COMPLETE_SERVICE_AREA,
  createWorker,
  getWorkerToken,
  saveAvailability,
  saveServiceArea,
  type JourneyWorker,
} from './worker-onboarding-journey.helpers';
import { TalentumV2Stub } from '../../src/modules/integration/infrastructure/__tests__/talentumV2Stub';
import { ShortIoStub } from '../../src/modules/matching/infrastructure/shortlinks/__tests__/shortIoStub';
import { vagaPublicavelSql } from '../../src/modules/matching/domain/vacancyPublication';
import { FindNearbyVacanciesForWorkerUseCase } from '../../src/modules/matching/application/FindNearbyVacanciesForWorkerUseCase';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TALENTUM_PORT = Number(process.env.TALENTUM_STUB_PORT ?? 9914);
const SHORTIO_PORT = Number(process.env.SHORT_IO_STUB_PORT ?? 9915);
const TAG = 'semaforo-f4';
const { lat: LAT0, lng: LNG0 } = COMPLETE_SERVICE_AREA;
// Dias 1 e 2: a prestadora cobre o 1 (COMPLETE_AVAILABILITY = 1 e 3) e falta o 2 — exatamente 1 dia faltando, o que a Luz oferece.
const HORARIO = [
  { dayOfWeek: 1, startTime: '09:00', endTime: '13:00' },
  { dayOfWeek: 2, startTime: '09:00', endTime: '13:00' },
];

describe('F4 (back) — a vaga não tem estado manual; "publicável" tem dono @integration', () => {
  const api = createApiClient();
  const talentum = new TalentumV2Stub();
  const shortIo = new ShortIoStub();
  const fechar: Array<() => Promise<void>> = [];
  let pool: Pool;
  let asAdmin: StaffAuth;
  let worker: JourneyWorker;
  let workerToken: string;
  let seq = 0;

  const bearer = () => ({ headers: { Authorization: `Bearer ${workerToken}` } });
  let registrado: { id: string; token: string } | null = null;
  /** Prestadora REGISTERED (elegível a candidatar-se): linha própria por INSERT, como `worker-application-eligibility.e2e`. */
  async function prestadoraRegistrada(): Promise<{ id: string; token: string }> {
    if (registrado) return registrado;
    const authUid = `uid-${TAG}-reg-${Date.now()}`;
    const email = `${TAG}-reg-${Date.now()}@e2e.test`;
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone) VALUES ($1, $2, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [authUid, email],
    )).rows[0].id;
    registrado = { id, token: await getMockToken(api, { uid: authUid, email, role: 'worker' }) };
    return registrado;
  }
  const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function limpar(): Promise<void> {
    const pats = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
    const arg = [`${TAG}%`];
    await pool.query(`DELETE FROM job_posting_prescreening_questions WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id IN (${pats}))`, arg);
    const vagas = `SELECT id FROM job_postings WHERE patient_id IN (${pats})`;
    await pool.query(`DELETE FROM worker_job_application_stage_history WHERE application_id IN (SELECT id FROM worker_job_applications WHERE job_posting_id IN (${vagas}))`, arg).catch(() => {});
    await pool.query(`DELETE FROM encuadres WHERE job_posting_id IN (${vagas})`, arg);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (${vagas})`, arg);
    await pool.query(`DELETE FROM worker_blocked_applications WHERE job_posting_id IN (${vagas})`, arg).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patient_addresses WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, arg);
  }

  /** Paciente SEARCHING com endereço a ~1 km da prestadora. */
  async function novoPaciente(tag: string, status = 'SEARCHING'): Promise<{ patientId: string; addressId: string }> {
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Semaforo', 'F4 QA', 'AR', $2) RETURNING id`,
      [`${TAG}-${tag}-${Date.now()}-${seq++}`, status],
    )).rows[0].id;
    const addressId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, city, neighborhood, lat, lng) VALUES ($1, 'Buenos Aires', $2, $3, $4) RETURNING id`,
      [patientId, `Barrio ${tag}`, LAT0 + 0.01, LNG0],
    )).rows[0].id;
    return { patientId, addressId };
  }

  /** A vaga nasce pelo MESMO INSERT do foguete (`POST /vacancies` → `buildInsertQuery`): PENDING_ACTIVATION, rascunho, sem ninguém escolher status. */
  async function novaVaga(p: { patientId: string; addressId: string }, caseNumber: number): Promise<string> {
    const r = await api.post('/api/admin/vacancies', {
      patient_id: p.patientId, case_number: caseNumber, patient_address_id: p.addressId,
      title: `${TAG}-${caseNumber}`, required_professions: ['AT'], schedule: HORARIO,
    }, asAdmin);
    expect(r.status).toBe(201);
    return r.data.data.id as string;
  }

  async function linha(id: string) {
    return (await pool.query<{ status: string; is_draft: boolean; talentum_pause_state: string | null; talentum_project_id: string | null; social_short_links: Record<string, unknown> | null; vacancy_number: number; case_number: number }>(
      `SELECT status, is_draft, talentum_pause_state, talentum_project_id, social_short_links, vacancy_number, case_number FROM job_postings WHERE id = $1`, [id],
    )).rows[0];
  }

  /** Vaga já lançada com projeto no stub (sem passar por Vertex nem publish): o que o estado de pausa precisa. */
  async function vagaPublicadaNoStub(p: { patientId: string; addressId: string }, caseNumber: number, over: { status?: string; pauseState?: string | null; semLink?: boolean } = {}): Promise<{ id: string; projectId: string }> {
    const id = await novaVaga(p, caseNumber);
    const projectId = `${TAG}-proj-${caseNumber}`;
    talentum.seed({ _id: projectId, name: `proj ${caseNumber}`, myRole: 'OWNER' });
    await pool.query(
      `UPDATE job_postings SET is_draft = false, status = $2, talentum_project_id = $3, talentum_pause_state = $4,
              social_short_links = CASE WHEN $5 THEN NULL ELSE '{"site":"https://stub.invalid/x"}'::jsonb END WHERE id = $1`,
      [id, over.status ?? 'PENDING_ACTIVATION', projectId, over.pauseState ?? null, over.semLink ?? false],
    );
    return { id, projectId };
  }

  const noFeed = async (id: string): Promise<boolean> => {
    const r = await api.get('/api/public/v1/jobs');
    expect(r.status).toBe(200);
    return (r.data.data as Array<{ id: string }>).some((j) => j.id === id);
  };
  const noRaio = async (id: string): Promise<boolean> => {
    const r = await api.get('/api/workers/me/jobs?radius_km=10', bearer());
    expect(r.status).toBe(200);
    return (r.data.items as Array<{ id: string }>).some((j) => j.id === id);
  };
  const aguardarEstado = async (id: string, final: string | null, ms = 20_000): Promise<string | null> => {
    const t0 = Date.now();
    let s = (await linha(id)).talentum_pause_state;
    while (s !== final && Date.now() - t0 < ms) { await espera(300); s = (await linha(id)).talentum_pause_state; }
    return s;
  };

  beforeAll(async () => {
    fechar.push((await talentum.serve(TALENTUM_PORT)).close);
    fechar.push((await shortIo.serve(SHORTIO_PORT)).close);
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    asAdmin = await staffAuth('semaforo-f4-admin', 'admin');
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role) VALUES ($1, $2, 'Semaforo F4 Admin', 'admin') ON CONFLICT (firebase_uid) DO NOTHING`,
      [asAdmin.uid, 'semaforo-f4-admin@e2e.local'],
    );
    await limpar();
    worker = await createWorker(api, 'sem-f4');
    workerToken = await getWorkerToken(api, worker);
    await saveServiceArea(api, workerToken);
    await saveAvailability(api, workerToken);
    await pool.query(`UPDATE workers SET occupation = 'AT' WHERE id = $1`, [worker.id]);
  }, 90_000);

  afterAll(async () => {
    await limpar();
    await pool.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [worker.id]).catch(() => {});
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [worker.id]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [[worker.id, ...(registrado ? [registrado.id] : [])]]).catch(() => {});
    const resto = await pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM patients WHERE clickup_task_id LIKE $1)::int + (SELECT count(*) FROM job_postings WHERE title LIKE $1)::int AS n`, [`${TAG}%`]);
    expect(resto.rows[0].n).toBe(0);
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [asAdmin.uid]).catch(() => {});
    await pool.end();
    for (const f of fechar) await f();
  });

  it('(i) vaga nova → publish no Talentum → feed público + busca por raio + página pública, short link pedido ao stub, SEM PUT de status', async () => {
    const p = await novoPaciente('i');
    const id = await novaVaga(p, 996001);
    const antes = await linha(id);
    expect(antes).toMatchObject({ status: 'PENDING_ACTIVATION', is_draft: true });
    expect(await noFeed(id)).toBe(false); // controle: rascunho está fora
    expect(await noRaio(id)).toBe(false);
    expect((await api.get(`/api/vacancies/${id}`)).status).toBe(404);

    await pool.query(`INSERT INTO job_posting_prescreening_questions (job_posting_id, question_order, question, desired_response, weight) VALUES ($1, 1, '¿Experiencia?', 'Sí', 5)`, [id]);
    await pool.query(`UPDATE job_postings SET talentum_description = 'Descripción QA' WHERE id = $1`, [id]);
    const criacoes = () => talentum.calls.filter((c) => c.method === 'POST' && c.path === '/projects').length;
    const postsAntes = criacoes();

    const pub = await api.post(`/api/admin/vacancies/${id}/publish-talentum`, {}, asAdmin);
    expect(pub.status).toBe(200);
    expect(criacoes()).toBe(postsAntes + 1); // o stub RECEBEU a criação do projeto
    const depois = await linha(id);
    expect(depois).toMatchObject({ status: 'PENDING_ACTIVATION', is_draft: false }); // nenhum PUT de status: segue PENDING_ACTIVATION
    // o link foi pedido ao STUB (nunca ao Short.io real) e gravado como o feed exige (`site`)
    expect(shortIo.createdFor(`caso${depois.case_number}-${depois.vacancy_number}`)).toHaveLength(1);
    expect(depois.social_short_links?.site).toBeTruthy();

    expect(await noFeed(id)).toBe(true);
    expect(await noRaio(id)).toBe(true);
    expect((await api.get(`/api/vacancies/${id}`)).status).toBe(200);
  }, 60_000);

  it('(ii) ATAQUE: PUT {status:"SEARCHING"} → 400 VACANCY_STATUS_NOT_WRITABLE com es + pt-BR, e o banco fica intacto', async () => {
    const p = await novoPaciente('ii');
    const id = await novaVaga(p, 996002);
    const antes = (await pool.query(`SELECT status, updated_at FROM job_postings WHERE id = $1`, [id])).rows[0];
    const auditAntes = Number((await pool.query(`SELECT count(*) AS n FROM job_posting_audit_log WHERE job_posting_id = $1`, [id])).rows[0].n);

    const r = await api.put(`/api/admin/vacancies/${id}`, { status: 'SEARCHING' }, asAdmin);
    expect(r.status).toBe(400);
    expect(r.data.code).toBe('VACANCY_STATUS_NOT_WRITABLE');
    expect(r.data.messages.es).toMatch(/no se edita/);
    expect(r.data.messages['pt-BR']).toMatch(/não é editável/);

    const depois = (await pool.query(`SELECT status, updated_at FROM job_postings WHERE id = $1`, [id])).rows[0];
    expect(depois).toEqual(antes);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM job_posting_audit_log WHERE job_posting_id = $1`, [id])).rows[0].n)).toBe(auditAntes);
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [p.patientId])).rows[0].status).toBe('SEARCHING');
  });

  it('(iii) ON_HOLD e CLOSED no PUT → 400; POST com status → 400 e nenhuma vaga criada', async () => {
    const p = await novoPaciente('iii');
    const id = await novaVaga(p, 996003);
    for (const status of ['ON_HOLD', 'CLOSED']) {
      const r = await api.put(`/api/admin/vacancies/${id}`, { status }, asAdmin);
      expect(r.status).toBe(400);
      expect(r.data.code).toBe('VACANCY_STATUS_NOT_WRITABLE');
    }
    expect((await linha(id)).status).toBe('PENDING_ACTIVATION');

    for (const status of ['SEARCHING', 'ON_HOLD', 'CLOSED']) {
      const r = await api.post('/api/admin/vacancies', { patient_id: p.patientId, case_number: 996013, title: `${TAG}-post-${status}`, status }, asAdmin);
      expect(r.status).toBe(400);
      expect(r.data.code).toBe('VACANCY_STATUS_NOT_WRITABLE');
    }
    const criadas = await pool.query(`SELECT 1 FROM job_postings WHERE case_number = 996013`);
    expect(criadas.rows).toHaveLength(0);
  });

  it('(iv) paciente pausado pela ação humana → a vaga some do feed e o Talentum recebe PUT pause; retomar → volta e recebe PUT resume; MANUAL_PAUSE de linha legada ON_HOLD e DE_BAJA ficam intactos', async () => {
    const p = await novoPaciente('iv');
    const viva = await vagaPublicadaNoStub(p, 996004);
    const manual = await vagaPublicadaNoStub(p, 996014, { status: 'ON_HOLD', pauseState: 'MANUAL_PAUSE' }); // legado ON_HOLD: fora de "publicável", a retomada não a toca
    const baixada = await vagaPublicadaNoStub(p, 996024, { status: 'DE_BAJA' });
    expect(await noFeed(viva.id)).toBe(true); // controle positivo
    expect(await noRaio(viva.id)).toBe(true);
    const pausasAntes = talentum.count('PUT', `/projects/${viva.projectId}/pause`);

    const pausa = await api.post(`/api/admin/patients/${p.patientId}/status-actions`, { action: 'pausar', onHoldReason: 'SCHOOL' }, asAdmin);
    expect(pausa.status).toBe(200);
    expect((await pool.query(`SELECT status FROM patients WHERE id = $1`, [p.patientId])).rows[0].status).toBe('ON_HOLD');
    // a vaga sai do feed e da busca por raio NA HORA (join com o paciente), sem escrita nela
    expect(await noFeed(viva.id)).toBe(false);
    expect(await noRaio(viva.id)).toBe(false);
    expect((await api.get(`/api/vacancies/${viva.id}`)).status).toBe(404);
    // o Talentum segue o paciente: PENDING_PAUSE marcado na transação → envio depois do commit → PAUSED
    expect(await aguardarEstado(viva.id, 'PAUSED')).toBe('PAUSED');
    expect(talentum.count('PUT', `/projects/${viva.projectId}/pause`)).toBe(pausasAntes + 1);
    expect(talentum.projects.get(viva.projectId)!.status).toBe('PAUSED');
    // intactos: a pausa manual de outro motivo, e a baixada (nem marcada, nem chamada)
    expect((await linha(manual.id)).talentum_pause_state).toBe('MANUAL_PAUSE');
    expect((await linha(baixada.id)).talentum_pause_state).toBeNull();
    expect(talentum.count('PUT', `/projects/${baixada.projectId}/`)).toBe(0);
    expect(talentum.count('PUT', `/projects/${manual.projectId}/`)).toBe(0);

    const retoma = await api.post(`/api/admin/patients/${p.patientId}/status-actions`, { action: 'retomar' }, asAdmin);
    expect(retoma.status).toBe(200);
    expect(['SEARCHING', 'REPLACEMENT', 'ACTIVE']).toContain((await pool.query(`SELECT status FROM patients WHERE id = $1`, [p.patientId])).rows[0].status);
    expect(await noFeed(viva.id)).toBe(true);
    expect(await noRaio(viva.id)).toBe(true);
    expect(await aguardarEstado(viva.id, null)).toBeNull(); // PENDING_RESUME → enviado → o estado é limpo
    expect(talentum.count('PUT', `/projects/${viva.projectId}/resume`)).toBe(1);
    expect(talentum.projects.get(viva.projectId)!.status).toBe('IN_PROGRESS');
    expect((await linha(manual.id)).talentum_pause_state).toBe('MANUAL_PAUSE'); // legado fora de "publicável": não é retomada (a publicável sim — caso xi)
    expect(talentum.count('PUT', `/projects/${manual.projectId}/`)).toBe(0);
    expect(talentum.count('PUT', `/projects/${baixada.projectId}/`)).toBe(0);
    expect((await linha(baixada.id)).status).toBe('DE_BAJA');
  }, 90_000);

  it('(v) linha legada ON_HOLD com is_draft=false → fora do feed, da busca por raio e da página; lifecycle = null (D6, opção A)', async () => {
    const p = await novoPaciente('v');
    const id = await novaVaga(p, 996005);
    await pool.query(`UPDATE job_postings SET status = 'ON_HOLD', is_draft = false, social_short_links = '{"site":"https://stub.invalid/v"}'::jsonb WHERE id = $1`, [id]);
    expect(await noFeed(id)).toBe(false);
    expect(await noRaio(id)).toBe(false);
    expect((await api.get(`/api/vacancies/${id}`)).status).toBe(404);
    const ficha = await api.get(`/api/admin/vacancies/${id}`, asAdmin);
    expect(ficha.status).toBe(200);
    expect(ficha.data.data).toMatchObject({ status: 'ON_HOLD', lifecycle: null });
    expect(ficha.data.data).not.toHaveProperty('resumeStatus');
    // controle: o MESMO registro com status PENDING_ACTIVATION entra — quem decide é o dono, não o status literal
    await pool.query(`UPDATE job_postings SET status = 'PENDING_ACTIVATION' WHERE id = $1`, [id]);
    expect(await noFeed(id)).toBe(true);
  });

  it('(vi) POST /vacancies/baja de vaga sem serviço → DE_BAJA, fora do feed, página pública 200 com is_disabled', async () => {
    const p = await novoPaciente('vi');
    const { id } = await vagaPublicadaNoStub(p, 996006);
    expect(await noFeed(id)).toBe(true); // controle positivo
    const baja = await api.post('/api/admin/vacancies/baja', { vacancyIds: [id] }, asAdmin);
    expect(baja.status).toBe(200);
    expect((await linha(id)).status).toBe('DE_BAJA');
    expect(await noFeed(id)).toBe(false);
    expect(await noRaio(id)).toBe(false);
    const pagina = await api.get(`/api/vacancies/${id}`);
    expect(pagina.status).toBe(200);
    expect(pagina.data.data).toMatchObject({ id, is_disabled: true, lifecycle: 'baja' });
  });

  it('(vii) vaga de serviço → baixa recusada com a mensagem nova (paciente ou serviço), vaga intacta', async () => {
    const p = await novoPaciente('vii');
    const svc = await api.post(`/api/admin/patients/${p.patientId}/contracted-services`, { serviceCode: 'AT', schedule: [{ dayOfWeek: 2, startTime: '09:00', durationMinutes: 240 }] }, asAdmin);
    expect(svc.status).toBe(201);
    // vaga COM serviço por SQL, como o 084 (o CHECK `service_owns_fields` exige os campos de recrutamento nulos)
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, vacancy_number, title, status, patient_id, contracted_service_id, country, is_draft, is_test, social_short_links)
       VALUES (996007, nextval('job_postings_vacancy_number_seq'), $1, 'PENDING_ACTIVATION', $2, $3, 'AR', false, false, '{}'::jsonb) RETURNING id`,
      [`${TAG}-996007`, p.patientId, svc.data.data.id],
    )).rows[0].id;

    const r = await api.post('/api/admin/vacancies/baja', { vacancyIds: [id] }, asAdmin);
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('BAJA_REFUSED');
    const msgs = r.data.refused[0].messages;
    expect(r.data.refused[0].code).toBe('VACANCY_HAS_SERVICE');
    expect(msgs.es).toMatch(/pausá o suspendé al paciente, o desactivá el servicio/);
    expect(msgs['pt-BR']).toMatch(/pause ou suspenda o paciente, ou desative o serviço/);
    expect((await linha(id)).status).toBe('PENDING_ACTIVATION');
  });

  it('(viii) a Luz lê o dono de publicável: o SQL que ela manda carrega a regra, e a MESMA regra tira a vaga de paciente SUSPENDED e o rascunho', async () => {
    // O `execute` da Luz tem um defeito ANTERIOR à F4 (`jp.patient_zone` não existe; `vacancyEffectiveFields.singleSource` o documenta e a LISTA
    // o registra): rodá-lo contra o banco real lança. Então a prova é em duas pontas: (a) o SQL que ela envia carrega `vagaPublicavelSql`;
    // (b) a regra do dono, rodada no banco real com o mesmo FROM/JOIN, filtra como a tela espera.
    const capturado: string[] = [];
    const espiao = { query: async (sql: string) => { capturado.push(sql); return { rows: [] }; } } as unknown as Pool;
    await new FindNearbyVacanciesForWorkerUseCase(espiao).execute(worker.id, 1, 30, 5);
    expect(capturado[0]).toContain(vagaPublicavelSql('jp', 'p'));
    expect(capturado[0]).toContain('LEFT JOIN patients p ON p.id = jp.patient_id');
    expect(capturado[0]).not.toMatch(/jp\.status\s*=\s*ANY/); // a lista própria `ACTIVE_STATUSES` saiu

    const p = await novoPaciente('viii');
    const { id } = await vagaPublicadaNoStub(p, 996008);
    const rascunho = await novaVaga(await novoPaciente('viii-r'), 996018);
    const publicaveis = async (): Promise<string[]> => (await pool.query<{ id: string }>(
      `SELECT jp.id FROM job_postings jp LEFT JOIN patients p ON p.id = jp.patient_id WHERE jp.id = ANY($1::uuid[]) AND ${vagaPublicavelSql('jp', 'p')}`,
      [[id, rascunho]],
    )).rows.map((r) => r.id);

    expect(await publicaveis()).toEqual([id]); // controle positivo: publicável entra, rascunho (que a Luz oferecia) fica de fora
    await pool.query(`UPDATE patients SET status = 'SUSPENDED' WHERE id = $1`, [p.patientId]);
    expect(await publicaveis()).toEqual([]);
    expect(await noFeed(id)).toBe(false);
    await pool.query(`UPDATE patients SET status = 'SEARCHING' WHERE id = $1`, [p.patientId]);
    expect(await publicaveis()).toEqual([id]);
  });

  it('(ix) P6: vaga lançada com o paciente pausado nasce SEM link (nada ao Short.io); quando o paciente retoma, ela volta ao feed COM o short link (1 POST /links)', async () => {
    const p = await novoPaciente('ix');
    const pausa = await api.post(`/api/admin/patients/${p.patientId}/status-actions`, { action: 'pausar', onHoldReason: 'SCHOOL' }, asAdmin);
    expect(pausa.status).toBe(200);
    const v = await vagaPublicadaNoStub(p, 996009, { semLink: true }); // lançada (is_draft=false) com o paciente em ON_HOLD
    const trecho = `caso996009-`;
    expect(await noFeed(v.id)).toBe(false); // não é publicável: o paciente está pausado
    expect(shortIo.createdFor(trecho)).toHaveLength(0); // o stub NÃO recebeu POST: o link não nasce com a vaga fora do ar
    expect((await linha(v.id)).social_short_links).toBeNull();

    const retoma = await api.post(`/api/admin/patients/${p.patientId}/status-actions`, { action: 'retomar' }, asAdmin);
    expect(retoma.status).toBe(200);
    const t0 = Date.now();
    while (shortIo.createdFor(trecho).length === 0 && Date.now() - t0 < 20_000) await espera(300);
    expect(shortIo.createdFor(trecho)).toHaveLength(1); // a retomada garantiu o link (um ponto só, o mesmo ensure do publish)
    expect((await linha(v.id)).social_short_links?.site).toBeTruthy(); // o que o feed exige (`social_short_links ? 'site'`)
    expect(await noFeed(v.id)).toBe(true);
    expect(await noRaio(v.id)).toBe(true);
  }, 90_000);

  it('(x) I1: publish com o paciente JÁ pausado → a vaga nasce PENDING_PAUSE na transação, o Talentum recebe PUT pause e ela fica fora do feed', async () => {
    const p = await novoPaciente('x');
    const pausa = await api.post(`/api/admin/patients/${p.patientId}/status-actions`, { action: 'pausar', onHoldReason: 'SCHOOL' }, asAdmin);
    expect(pausa.status).toBe(200);
    const id = await novaVaga(p, 996010);
    await pool.query(`INSERT INTO job_posting_prescreening_questions (job_posting_id, question_order, question, desired_response, weight) VALUES ($1, 1, '¿Experiencia?', 'Sí', 5)`, [id]);
    await pool.query(`UPDATE job_postings SET talentum_description = 'Descripción QA' WHERE id = $1`, [id]);
    const criacoes = talentum.calls.filter((c) => c.method === 'POST' && c.path === '/projects').length;

    const pub = await api.post(`/api/admin/vacancies/${id}/publish-talentum`, {}, asAdmin);
    expect(pub.status).toBe(200);
    expect(talentum.calls.filter((c) => c.method === 'POST' && c.path === '/projects').length).toBe(criacoes + 1); // o projeto FOI criado no stub
    const depois = await linha(id);
    expect(depois.is_draft).toBe(false);
    expect(depois.talentum_project_id).toBeTruthy();
    // marcada na MESMA transação do publish: logo após a resposta nunca é NULL (PENDING_PAUSE, ou já o final PAUSED)
    expect(['PENDING_PAUSE', 'PAUSED']).toContain(depois.talentum_pause_state);
    expect(await aguardarEstado(id, 'PAUSED')).toBe('PAUSED');
    expect(talentum.count('PUT', `/projects/${depois.talentum_project_id}/pause`)).toBe(1); // o stub RECEBEU a pausa
    expect(talentum.projects.get(depois.talentum_project_id!)!.status).toBe('PAUSED');
    expect(await noFeed(id)).toBe(false);
    expect(await noRaio(id)).toBe(false);
    expect(shortIo.createdFor(`caso996010-`)).toHaveLength(0); // fora do ar → sem short link (P6)

    // controle: a MESMA publicação com o paciente vivo NÃO marca pausa
    const vivo = await novoPaciente('x-vivo');
    const idVivo = await novaVaga(vivo, 996020);
    await pool.query(`INSERT INTO job_posting_prescreening_questions (job_posting_id, question_order, question, desired_response, weight) VALUES ($1, 1, '¿Experiencia?', 'Sí', 5)`, [idVivo]);
    await pool.query(`UPDATE job_postings SET talentum_description = 'Descripción QA' WHERE id = $1`, [idVivo]);
    expect((await api.post(`/api/admin/vacancies/${idVivo}/publish-talentum`, {}, asAdmin)).status).toBe(200);
    expect((await linha(idVivo)).talentum_pause_state).toBeNull();
  }, 90_000);

  it('(xi) I3: o Talentum recusa a pausa (403) → MANUAL_PAUSE + lista manual; o paciente retoma → PUT resume e a vaga sai da lista "pausar a mano"', async () => {
    const p = await novoPaciente('xi');
    const v = await vagaPublicadaNoStub(p, 996011);
    talentum.projects.get(v.projectId)!.myRole = 'VIEWER'; // a conta não é dona do projeto: escrita dá 403 (mecanismo do 084-talentum-403)
    const manual = async (): Promise<string[]> => {
      const r = await api.get(`/api/admin/vacancies?search=996011&talentum_manual=true&limit=50`, asAdmin);
      expect(r.status).toBe(200);
      return (r.data.data as Array<{ id: string }>).map((i) => i.id);
    };

    expect((await api.post(`/api/admin/patients/${p.patientId}/status-actions`, { action: 'pausar', onHoldReason: 'SCHOOL' }, asAdmin)).status).toBe(200);
    expect(await aguardarEstado(v.id, 'MANUAL_PAUSE')).toBe('MANUAL_PAUSE');
    expect(await manual()).toEqual([v.id]);
    expect(talentum.count('PUT', `/projects/${v.projectId}/pause`)).toBeGreaterThanOrEqual(1);

    // o time pausa o projeto à mão no Talentum e o paciente volta: a retomada tem de limpar o MANUAL_PAUSE
    Object.assign(talentum.projects.get(v.projectId)!, { myRole: 'OWNER', status: 'PAUSED' });
    expect((await api.post(`/api/admin/patients/${p.patientId}/status-actions`, { action: 'retomar' }, asAdmin)).status).toBe(200);
    expect(await aguardarEstado(v.id, null)).toBeNull();
    expect(talentum.count('PUT', `/projects/${v.projectId}/resume`)).toBe(1);
    expect(talentum.projects.get(v.projectId)!.status).toBe('IN_PROGRESS');
    expect(await manual()).toEqual([]); // saiu da lista manual
  }, 90_000);

  it('(xii) I4: candidatura pelo app decide pelo dono de publicável — paciente SUSPENDED → 409 VACANCY_NOT_PUBLISHABLE e nenhuma candidatura criada; paciente vivo → 200', async () => {
    const reg = await prestadoraRegistrada();
    const candidaturas = async (jobId: string): Promise<number> =>
      Number((await pool.query(`SELECT count(*) AS n FROM worker_job_applications WHERE job_posting_id = $1 AND worker_id = $2`, [jobId, reg.id])).rows[0].n);
    const candidatar = (jobId: string) => api.post('/api/worker-applications/track-channel', { jobPostingId: jobId, channel: 'facebook' }, { headers: { Authorization: `Bearer ${reg.token}` } });

    const vivo = await vagaPublicadaNoStub(await novoPaciente('xii-vivo'), 996012);
    const ok = await candidatar(vivo.id);
    expect(ok.status).toBe(200); // controle positivo: a mesma worker, a mesma rota, vaga publicável
    expect(await candidaturas(vivo.id)).toBe(1);

    const pSusp = await novoPaciente('xii-susp', 'SUSPENDED');
    const susp = await vagaPublicadaNoStub(pSusp, 996022);
    expect(await noFeed(susp.id)).toBe(false); // o dono diz: não publicável
    const r = await candidatar(susp.id);
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ success: false, code: 'VACANCY_NOT_PUBLISHABLE', reason: 'vacancy_not_publishable' });
    expect(await candidaturas(susp.id)).toBe(0);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM encuadres WHERE job_posting_id = $1`, [susp.id])).rows[0].n)).toBe(0);

    // DE_BAJA mantém o código da 084
    const baixada = await vagaPublicadaNoStub(await novoPaciente('xii-baja'), 996032, { status: 'DE_BAJA' });
    const rb = await candidatar(baixada.id);
    expect(rb.status).toBe(409);
    expect(rb.data).toMatchObject({ code: 'VACANCY_DE_BAJA', reason: 'vacancy_de_baja' });
  }, 60_000);

  it('(xiii) B3b: vaga is_test publicável abre na página pública (200) e aceita candidatura, e NÃO aparece no feed nem na busca por raio', async () => {
    const reg = await prestadoraRegistrada();
    const normal = await vagaPublicadaNoStub(await novoPaciente('xiii-n'), 996013 + 100);
    const teste = await vagaPublicadaNoStub(await novoPaciente('xiii-t'), 996013 + 200);
    await pool.query(`UPDATE job_postings SET is_test = true WHERE id = $1`, [teste.id]);

    expect(await noFeed(normal.id)).toBe(true); // controle positivo: a vaga normal entra no feed
    expect(await noFeed(teste.id)).toBe(false);
    expect(await noRaio(teste.id)).toBe(false);
    expect((await api.get(`/api/vacancies/${normal.id}`)).status).toBe(200);
    const pagina = await api.get(`/api/vacancies/${teste.id}`);
    expect(pagina.status).toBe(200); // a página pública segue servindo a vaga de teste (a jornada de teste em prd)
    expect(pagina.data.data.id).toBe(teste.id);
    const cand = await api.post('/api/worker-applications/track-channel', { jobPostingId: teste.id, channel: 'facebook' }, { headers: { Authorization: `Bearer ${reg.token}` } });
    expect(cand.status).toBe(200);
  }, 60_000);

  it('mapa de outbound: só o stub recebeu — Talentum só em /projects, Short.io só POST /links; nenhum DELETE no Talentum', async () => {
    for (const c of talentum.calls) expect(c.path === '/auth/login' || c.path.startsWith('/projects')).toBe(true);
    expect(talentum.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(shortIo.calls.length).toBeGreaterThan(0); // contagem zero é falha: o link do (i) TEM de ter chegado ao stub
    for (const c of shortIo.calls) expect(`${c.method} ${c.path}`).toBe('POST /links');
    expect(shortIo.calls.every((c) => (c.domain ?? '').endsWith('.local'))).toBe(true); // domínio FALSO do compose
  });
});
