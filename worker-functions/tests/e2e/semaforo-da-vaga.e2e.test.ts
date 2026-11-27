/**
 * semaforo-da-vaga.e2e.test.ts @integration — semaforo-da-vaga, F2 (D811, P1/P2/P3).
 *
 * UMA semente, três leitores do MESMO `n` (fragmento `semaforoContagemSql`):
 *   (1) GET /api/admin/vacancies                → `semaphore: { n, color } | null` + filtro `?semaphore=`
 *   (2) GET /api/admin/patients/kanban/services → `services[].semaphore` e `patients[].worstSemaphore`
 *   (3) GET /api/admin/vacancies/:id/funnel     → cards SELECTED + QUICK_RESPONSE_TEAM (a fonte que o `n` espelha)
 *
 * Banco real, sem mock. As vagas são `is_test = false` (a lista esconde vaga de teste) e a limpeza é por prefixo.
 *
 *   (i)   vagas com 4, 5, 9 e 10 candidaturas SELECTED/QRT → red, yellow, yellow, green
 *   (ii)  +1 worker DISABLED e +1 REJECTED na vaga de 4 → continua n = 4
 *   (iii) P3: marca de saída ATIVA no serviço → n cai 1; revertida → volta
 *   (iv)  ?semaphore=red só vermelhas, nenhuma baixada, com filtro e paginação nos DOIS caminhos (com e sem sort);
 *         ?semaphore=blue → 400 VACANCY_SEMAPHORE_INVALID com as 2 mensagens
 *   (v)   a mesma vaga dá o mesmo n na lista, no Kanban de pacientes e na soma de cards do funil
 *   (vi)  paciente com 2 serviços (red e green) → worstSemaphore = red; serviço sem vaga viva → null
 *   (vii) mover 1 card COMPLETED → SELECTED por PUT → n relido sobe 1, sem escrita em job_postings (updated_at igual)
 *   (viii) vaga SEM serviço: conta por inteiro (o recorte de P3 não se aplica)
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { completeWorkerProfile } from './helpers/aptoWorkerFixture';
import { setWorkerStatusForTest } from './helpers/setWorkerStatusForTest';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `sem-${RUN}-`;

type Color = 'red' | 'yellow' | 'green';
interface Sem { n: number; color: Color }
interface ListRow { id: string; title?: string; semaphore: Sem | null }

describe('semáforo da vaga — lista = Kanban de pacientes = funil (uma semente) @integration', () => {
  const api = createApiClient();
  let headers: { Authorization: string };
  let pool: Pool;
  let seq = 0;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pool.query(sql, params)).rows as T[];

  interface Seed { vacancyId: string; serviceId: string | null; patientId: string | null; workers: string[] }
  const seeds: Record<string, Seed> = {};

  async function mkWorker(label: string): Promise<string> {
    seq += 1;
    return (await q<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, country, status) VALUES ($1, $2, 'AR', 'REGISTERED') RETURNING id`,
      [`${PREFIX}${label}-${seq}`, `${PREFIX}${label}-${seq}@e2e.local`],
    ))[0].id;
  }

  async function mkApplication(workerId: string, vacancyId: string, stage: string): Promise<void> {
    await q(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage) VALUES ($1, $2, $3)`, [workerId, vacancyId, stage]);
  }

  async function mkPatient(label: string): Promise<string> {
    return (await q<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Semaforo', $2, 'AR', 'ACTIVE') RETURNING id`,
      [`${PREFIX}${label}`, `${label} QA`],
    ))[0].id;
  }

  async function mkService(patientId: string): Promise<string> {
    const addressId = (await q<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`, [patientId]))[0].id;
    return (await q<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
      [patientId, addressId, PREFIX],
    ))[0].id;
  }

  /** `n` candidaturas SELECTED/QRT (metade e metade, o 1º SELECTED), numa vaga com ou sem serviço. */
  async function mkVacancy(label: string, n: number, opts: { patientId?: string | null; withService?: boolean; status?: string } = {}): Promise<Seed> {
    const withService = opts.withService ?? true;
    const patientId = withService ? (opts.patientId ?? (await mkPatient(label))) : null;
    const serviceId = withService && patientId ? await mkService(patientId) : null;
    seq += 1;
    const vacancyId = (await q<{ id: string }>(
      `INSERT INTO job_postings (title, status, is_draft, country, case_number, patient_id, contracted_service_id, providers_needed)
       VALUES ($1, $2, false, 'AR', $3, $4, $5, $6) RETURNING id`,
      [`${PREFIX}${label}`, opts.status ?? 'SEARCHING', 97000 + (RUN % 1000) * 10 + seq, patientId, serviceId, serviceId ? null : '12'], // com serviço, providers_needed é do serviço (CHECK service_owns_fields)
    ))[0].id;
    const workers: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const w = await mkWorker(label);
      workers.push(w);
      await mkApplication(w, vacancyId, i % 2 === 0 ? 'SELECTED' : 'QUICK_RESPONSE_TEAM');
    }
    const seed = { vacancyId, serviceId, patientId, workers };
    seeds[label] = seed;
    return seed;
  }

  const listUrl = (extra = '', limit = 100): string => `/api/admin/vacancies?search=${encodeURIComponent(PREFIX)}&limit=${limit}${extra}`;
  const readList = async (extra = ''): Promise<ListRow[]> => {
    const res = await api.get(listUrl(extra), { headers });
    expect(res.status).toBe(200);
    return res.data.data as ListRow[];
  };
  const semOf = async (vacancyId: string, extra = ''): Promise<Sem | null> => (await readList(extra)).find((r) => r.id === vacancyId)?.semaphore ?? null;

  const kanban = async (): Promise<Array<{ patientId: string; worstSemaphore: Color | null; services: Array<{ contractedServiceId: string; semaphore: Sem | null }> }>> => {
    const res = await api.get('/api/admin/patients/kanban/services?country=AR', { headers });
    expect(res.status).toBe(200);
    return res.data.data.patients;
  };

  const kanbanN = async (patientId: string, serviceId: string): Promise<number | undefined> =>
    (await kanban()).find((p) => p.patientId === patientId)?.services.find((sv) => sv.contractedServiceId === serviceId)?.semaphore?.n;

  const funnelCards = async (vacancyId: string): Promise<number> => {
    const res = await api.get(`/api/admin/vacancies/${vacancyId}/funnel`, { headers });
    expect(res.status).toBe(200);
    const stages = res.data.data.stages as Record<string, unknown[]>;
    return stages.SELECTED.length + stages.QUICK_RESPONSE_TEAM.length;
  };

  beforeAll(async () => {
    await waitForBackend(api);
    headers = (await staffAuth(`${PREFIX}admin`, 'admin')).headers;
    pool = new Pool({ connectionString: DATABASE_URL });

    // Um paciente com 2 serviços (vermelho + verde): o worstSemaphore (vi). Os demais têm 1 serviço cada.
    const duo = await mkPatient('duo');
    await mkVacancy('v4', 4, { patientId: duo });
    await mkVacancy('v10', 10, { patientId: duo });
    await mkVacancy('v2', 2);
    await mkVacancy('v5', 5);
    await mkVacancy('v9', 9);
    await mkVacancy('sem-servico', 5, { withService: false });
    await mkVacancy('baixada', 0, { status: 'DE_BAJA' });
    // Serviço ativo SEM vaga viva: o Kanban devolve semaphore null (sin vacante, nunca 0).
    const semVagaPaciente = await mkPatient('sem-vaga');
    seeds['sem-vaga'] = { vacancyId: '', serviceId: await mkService(semVagaPaciente), patientId: semVagaPaciente, workers: [] };
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM contracted_service_rejections WHERE created_by = $1`, [PREFIX]);
    await pool.query(`DELETE FROM encuadres WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM worker_documents WHERE worker_id IN (SELECT id FROM workers WHERE auth_uid LIKE $1)`, [`${PREFIX}%`]).catch(() => undefined);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PREFIX}%`]).catch(() => undefined);
    await pool.end();
  });

  it('(i) vagas com 4, 5, 9 e 10 candidaturas dão red, yellow, yellow, green na lista', async () => {
    const rows = await readList();
    const sem = (label: string): Sem | null => rows.find((r) => r.id === seeds[label].vacancyId)?.semaphore ?? null;
    expect(sem('v4')).toEqual({ n: 4, color: 'red' });
    expect(sem('v5')).toEqual({ n: 5, color: 'yellow' });
    expect(sem('v9')).toEqual({ n: 9, color: 'yellow' });
    expect(sem('v10')).toEqual({ n: 10, color: 'green' });
  });

  it('(ii) +1 worker DISABLED e +1 candidatura REJECTED na vaga de 4: continua n = 4', async () => {
    const { vacancyId } = seeds.v4;
    const desligado = await mkWorker('disabled');
    await mkApplication(desligado, vacancyId, 'SELECTED');
    await setWorkerStatusForTest(pool, desligado, 'DISABLED');
    const rejeitado = await mkWorker('rejected');
    await mkApplication(rejeitado, vacancyId, 'REJECTED');
    expect(await semOf(vacancyId)).toEqual({ n: 4, color: 'red' });
  });

  it('(iii) P3: marca de saída ATIVA no serviço derruba n em 1; revertida, volta', async () => {
    const { vacancyId, serviceId, workers } = seeds.v5;
    expect(await semOf(vacancyId)).toEqual({ n: 5, color: 'yellow' });
    const marca = (await q<{ id: string }>(
      `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by, country)
       VALUES ($1, $2, $3, 'OTHER', $3, $3, 'AR') RETURNING id`,
      [serviceId, workers[0], PREFIX],
    ))[0].id;
    expect(await semOf(vacancyId)).toEqual({ n: 4, color: 'red' });
    expect(await kanbanN(seeds.v5.patientId!, serviceId!)).toBe(4); // o Kanban de pacientes lê o MESMO fragmento (com o recorte de P3)
    await q(
      `UPDATE contracted_service_rejections SET reverted_at = now(), reverted_by = $2, revert_reason_category = 'OTHER', updated_by = $2 WHERE id = $1`,
      [marca, PREFIX],
    );
    expect(await semOf(vacancyId)).toEqual({ n: 5, color: 'yellow' });
    expect(await kanbanN(seeds.v5.patientId!, serviceId!)).toBe(5);
  });

  it('(iv) ?semaphore=red devolve só as vermelhas e nenhuma baixada; filtro e paginação valem com e sem sort; blue dá 400', async () => {
    const vermelhas = [seeds.v4.vacancyId, seeds.v2.vacancyId].sort();

    for (const caminho of ['', '&sort=selected&order=desc']) {
      const todas = await api.get(listUrl(`&semaphore=red&include_baja=true${caminho}`), { headers });
      expect(todas.status).toBe(200);
      const rows = todas.data.data as ListRow[];
      expect(rows.map((r) => r.id).sort()).toEqual(vermelhas);
      expect(rows.every((r) => r.semaphore?.color === 'red')).toBe(true);
      expect(rows.find((r) => r.id === seeds.baixada.vacancyId)).toBeUndefined(); // a baixada tem 0 candidaturas e NÃO entra
      expect(todas.data.total).toBe(2);

      const p1 = await api.get(listUrl(`&semaphore=red&offset=0${caminho}`, 1), { headers });
      const p2 = await api.get(listUrl(`&semaphore=red&offset=1${caminho}`, 1), { headers });
      expect(p1.data.total).toBe(2);
      expect(p2.data.total).toBe(2);
      expect([...(p1.data.data as ListRow[]), ...(p2.data.data as ListRow[])].map((r) => r.id).sort()).toEqual(vermelhas);
    }

    // a baixada, vista sem filtro, aparece com semaphore null (P2: um sentido só)
    const comBaixadas = await readList('&include_baja=true');
    expect(comBaixadas.find((r) => r.id === seeds.baixada.vacancyId)?.semaphore).toBeNull();

    // CSV: vermelho + verde
    const csv = await readList('&semaphore=red,green');
    expect(csv.map((r) => r.id).sort()).toEqual([seeds.v4.vacancyId, seeds.v2.vacancyId, seeds.v10.vacancyId].sort());

    const ruim = await api.get(listUrl('&semaphore=blue'), { headers, validateStatus: () => true });
    expect(ruim.status).toBe(400);
    expect(ruim.data.code).toBe('VACANCY_SEMAPHORE_INVALID');
    expect(ruim.data.messages.es).toEqual(expect.any(String));
    expect(ruim.data.messages['pt-BR']).toEqual(expect.any(String));
    expect(ruim.data.messages.es).not.toBe(ruim.data.messages['pt-BR']);
  });

  it('(v) a mesma vaga dá o mesmo n na lista, no Kanban de pacientes e na soma de cards SELECTED+QRT do funil', async () => {
    const { vacancyId, serviceId, patientId } = seeds.v4;
    const naLista = (await semOf(vacancyId))!.n;
    const noKanban = (await kanban()).find((p) => p.patientId === patientId)!.services.find((s) => s.contractedServiceId === serviceId)!.semaphore!.n;
    const noFunil = await funnelCards(vacancyId);
    expect(naLista).toBe(4);
    expect(noKanban).toBe(naLista);
    expect(noFunil).toBe(naLista);
  });

  it('(vi) paciente com 2 serviços (red e green): worstSemaphore = red; serviço sem vaga viva = null', async () => {
    const patients = await kanban();
    const duo = patients.find((p) => p.patientId === seeds.v4.patientId)!;
    expect(duo.services.map((s) => s.semaphore?.color).sort()).toEqual(['green', 'red']);
    expect(duo.worstSemaphore).toBe('red');
    const semVaga = patients.find((p) => p.patientId === seeds['sem-vaga'].patientId)!;
    expect(semVaga.services[0].semaphore).toBeNull();
    expect(semVaga.worstSemaphore).toBeNull();
  });

  it('(vii) mover 1 card de COMPLETED para SELECTED por PUT: n sobe 1 e job_postings não é escrito', async () => {
    const { vacancyId } = seeds.v9;
    const worker = await mkWorker('movido');
    await completeWorkerProfile(pool, worker, 'validated');
    await mkApplication(worker, vacancyId, 'COMPLETED');
    await q(
      `INSERT INTO encuadres (worker_id, job_posting_id, resultado, dedup_hash) VALUES ($1, $2, 'PENDIENTE', $3) ON CONFLICT DO NOTHING`,
      [worker, vacancyId, `${PREFIX}dedup`],
    );
    const encuadreId = (await q<{ id: string }>(`SELECT id FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2`, [worker, vacancyId]))[0].id;
    expect(await semOf(vacancyId)).toEqual({ n: 9, color: 'yellow' }); // COMPLETED não conta
    const antes = (await q<{ updated_at: string }>(`SELECT updated_at::text FROM job_postings WHERE id = $1`, [vacancyId]))[0].updated_at;

    const res = await api.put(`/api/admin/encuadres/${encuadreId}/move`, { targetStage: 'SELECTED', reasonCategory: 'ENCUADRE_ANTECIPADO' }, { headers, validateStatus: () => true });
    expect(res.status).toBe(200);

    expect(await semOf(vacancyId)).toEqual({ n: 10, color: 'green' });
    const depois = (await q<{ updated_at: string }>(`SELECT updated_at::text FROM job_postings WHERE id = $1`, [vacancyId]))[0].updated_at;
    expect(depois).toBe(antes);
  });

  it('(viii) vaga SEM serviço conta por inteiro: o recorte de P3 não se aplica', async () => {
    expect(await semOf(seeds['sem-servico'].vacancyId)).toEqual({ n: 5, color: 'yellow' });
  });
});
