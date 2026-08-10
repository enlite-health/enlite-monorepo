/**
 * worker-disabled-oculto.e2e.test.ts
 *
 * Worker que deu BAIXA na conta (`status='DISABLED'` — a Luz executa via
 * `deactivate_account`) não pode continuar aparecendo como se fosse contatável.
 *
 * Cobre as superfícies operacionais contra Postgres + API reais:
 *   - kanban da vaga, tabela (GET /vacancies/:id/funnel-table) — linhas E contadores
 *   - kanban da vaga, cards (GET /vacancies/:id/funnel) — colunas do Kanban
 *   - candidatos da vaga (GET /vacancies/:id/match-results) — lista E total
 *   - contadores da listagem de vagas (GET /vacancies)
 *   - salud del reclutamiento (GET /admin/recruitment/encuadres)
 *   - detalhe da vaga (GET /vacancies/:id) — array de encuadres agregado
 *   - analytics: missing-documents, incomplete-registrations, métricas de
 *     caso e reemplazos (GET /analytics/*)
 *   - bulk-dispatch-incomplete dry-run (POST /admin/messaging/bulk-dispatch-incomplete)
 *   - busca do painel (GET /workers) — some por padrão, aparece com
 *     ?status=DISABLED (é assim que o admin acha alguém para reverter a baixa)
 *
 * O dado NÃO é apagado: a baixa é reversível e auditada. Por isso o teste
 * termina reativando o worker e conferindo que ele VOLTA a aparecer.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Worker com baixa de conta (DISABLED) some das superfícies operacionais', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let vacancyId: string;
  let activeWorkerId: string;
  let disabledWorkerId: string;
  const uniqueCaseNumber = 99971;
  const suffix = `disabled-${Date.now()}`;

  const auth = () => ({ headers: { Authorization: `Bearer ${adminToken}` } });

  async function createWorker(tag: string, status: string): Promise<string> {
    const res = await pool.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', $3)
       RETURNING id`,
      [`uid-${tag}-${suffix}`, `worker-${tag}-${suffix}@disabled.test`, status],
    );
    return res.rows[0].id as string;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'disabled-filter-admin',
      email: 'disabled-filter-admin@e2e.local',
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'disabled-filter');

    const vacancy = await pool.query(
      `INSERT INTO job_postings (title, description, country, status, patient_id, case_number, providers_needed)
       VALUES ('Caso E2E baja de cuenta', 'desc', 'AR', 'SEARCHING', $1, $2, '2')
       RETURNING id`,
      [patientId, uniqueCaseNumber],
    );
    vacancyId = vacancy.rows[0].id as string;

    // Dois candidatos idênticos na MESMA etapa: a única diferença é a baixa.
    activeWorkerId = await createWorker('activo', 'REGISTERED');
    disabledWorkerId = await createWorker('baja', 'REGISTERED');
    for (const workerId of [activeWorkerId, disabledWorkerId]) {
      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, messaged_at)
         VALUES ($1, $2, 'INVITED', NOW())`,
        [workerId, vacancyId],
      );
    }
    // A baixa acontece DEPOIS da candidatura — como no caso real (o worker é
    // convidado, responde "baja", e a Luz desativa a conta).
    await pool.query(`UPDATE workers SET status = 'DISABLED' WHERE id = $1`, [disabledWorkerId]);

    // Nada a inserir em encuadres: trg_ensure_encuadre_on_wja_insert (migration 189)
    // já criou 1 encuadre por WJA automaticamente — é isso que alimenta
    // /admin/recruitment/encuadres (tela "Salud del Reclutamiento").
  });

  afterAll(async () => {
    // encuadres.worker_id é ON DELETE SET NULL (não CASCADE) — apagar explícito.
    await pool.query(`DELETE FROM encuadres WHERE job_posting_id = $1`, [vacancyId]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [vacancyId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [
      [activeWorkerId, disabledWorkerId],
    ]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.end();
  });

  it('kanban da vaga: não lista o worker que deu baixa, e o contador acompanha', async () => {
    const res = await api.get(`/api/admin/vacancies/${vacancyId}/funnel-table`, auth());

    expect(res.status).toBe(200);
    const rows = res.data.data.rows as Array<{ workerId: string }>;
    const ids = rows.map((r) => r.workerId);

    expect(ids).toContain(activeWorkerId);
    expect(ids).not.toContain(disabledWorkerId);
    // O contador da aba é derivado das MESMAS linhas — não pode divergir.
    expect(res.data.data.counts.ALL).toBe(1);
    expect(res.data.data.counts.INVITED).toBe(1);
  });

  it('kanban da vaga (cards): não lista o worker que deu baixa em nenhuma coluna', async () => {
    const res = await api.get(`/api/admin/vacancies/${vacancyId}/funnel`, auth());

    expect(res.status).toBe(200);
    const stages = res.data.data.stages as Record<string, Array<{ workerId: string }>>;
    const allIds = Object.values(stages)
      .flat()
      .map((card) => card.workerId);

    expect(allIds).toContain(activeWorkerId);
    expect(allIds).not.toContain(disabledWorkerId);
  });

  it('candidatos da vaga: fora da lista e fora do total', async () => {
    const res = await api.get(`/api/admin/vacancies/${vacancyId}/match-results`, auth());

    expect(res.status).toBe(200);
    const ids = (res.data.data.candidates as Array<{ workerId: string }>).map((c) => c.workerId);
    expect(ids).toContain(activeWorkerId);
    expect(ids).not.toContain(disabledWorkerId);
    expect(res.data.data.totalCandidates).toBe(1);
  });

  it('listagem de vagas: contador de convidados não conta quem deu baixa', async () => {
    const res = await api.get('/api/admin/vacancies?limit=200', auth());

    expect(res.status).toBe(200);
    const vacancy = (res.data.data as Array<Record<string, unknown>>).find(
      (v) => v.id === vacancyId,
    );
    expect(vacancy).toBeDefined();
    // O mapper devolve o contador como string com zero à esquerda ('01').
    expect(vacancy!.convidados).toBe('01');
    // 2 vagas pedidas, ninguém selecionado ainda.
    expect(vacancy!.faltantes).toBe('02');
  });

  it('salud del reclutamiento (/recruitment/encuadres): não lista o worker que deu baixa', async () => {
    const res = await api.get(
      `/api/admin/recruitment/encuadres?caseNumber=${uniqueCaseNumber}&limit=50`,
      auth(),
    );

    expect(res.status).toBe(200);
    // Colunas cruas do Postgres (snake_case) — este controller não remapeia pra camelCase.
    const ids = (res.data.data as Array<{ worker_id: string }>).map((e) => e.worker_id);
    expect(ids).toContain(activeWorkerId);
    expect(ids).not.toContain(disabledWorkerId);
    expect(res.data.pagination.total).toBe(1);
  });

  it('detalhe da vaga (/vacancies/:id): worker que deu baixa some do array de encuadres', async () => {
    const encuadreRows = await pool.query(
      `SELECT id, worker_id FROM encuadres WHERE job_posting_id = $1`,
      [vacancyId],
    );
    const activeEncuadreId = encuadreRows.rows.find((r) => r.worker_id === activeWorkerId)?.id;
    const disabledEncuadreId = encuadreRows.rows.find((r) => r.worker_id === disabledWorkerId)?.id;
    expect(activeEncuadreId).toBeDefined();
    expect(disabledEncuadreId).toBeDefined();

    const res = await api.get(`/api/admin/vacancies/${vacancyId}`, auth());
    expect(res.status).toBe(200);
    // Resposta não traz worker_id no array agregado — identifica pelo id do encuadre.
    const encuadreIds = ((res.data.data.encuadres ?? []) as Array<{ id: string }>).map((e) => e.id);
    expect(encuadreIds).toContain(activeEncuadreId);
    expect(encuadreIds).not.toContain(disabledEncuadreId);
  });

  it('analytics: workers sem documentos não inclui quem deu baixa', async () => {
    const res = await api.get('/analytics/workers/missing-documents?limit=5000', auth());
    expect(res.status).toBe(200);
    const ids = (res.data.data as Array<{ workerId: string }>).map((w) => w.workerId);
    expect(ids).toContain(activeWorkerId);
    expect(ids).not.toContain(disabledWorkerId);
  });

  it('analytics: cadastros incompletos da vaga não inclui quem deu baixa', async () => {
    const res = await api.get(`/analytics/vacancies/${vacancyId}/incomplete-registrations`, auth());
    expect(res.status).toBe(200);
    const ids = (res.data.data as Array<{ workerId: string }>).map((w) => w.workerId);
    expect(ids).toContain(activeWorkerId);
    expect(ids).not.toContain(disabledWorkerId);
  });

  it('métricas do caso (/analytics/dashboard/cases/:caseNumber): contadores não incluem quem deu baixa', async () => {
    const res = await api.get(`/analytics/dashboard/cases/${uniqueCaseNumber}`, auth());
    expect(res.status).toBe(200);
    // 2 encuadres existem (1 por worker), mas o desativado não deve contar.
    expect(res.data.data.candidatosCount).toBe(1);
    expect(res.data.data.invitados).toBe(1);
  });

  it('reemplazos (/analytics/dashboard/reemplazos): contador de seleccionados não conta quem deu baixa', async () => {
    await pool.query(`UPDATE encuadres SET resultado = 'SELECCIONADO' WHERE job_posting_id = $1`, [
      vacancyId,
    ]);

    const res = await api.get('/analytics/dashboard/reemplazos?country=AR', auth());
    expect(res.status).toBe(200);
    const caseCounts = res.data.data.reemplazosCounts[String(uniqueCaseNumber)];
    expect(caseCounts).toBeDefined();
    expect(caseCounts.sel).toBe(1);

    await pool.query(`UPDATE encuadres SET resultado = NULL WHERE job_posting_id = $1`, [vacancyId]);
  });

  it('bulk-dispatch-incomplete (dry-run): não inclui quem deu baixa, mesmo sem opt-out gravado', async () => {
    // Fixture não tem opt-out formal — reproduz o cenário do reforço (baixa manual
    // via PUT /workers/:id/status não grava messaging_opt_out).
    const phoneActive = `+549111${Date.now().toString().slice(-7)}1`;
    const phoneDisabled = `+549111${Date.now().toString().slice(-7)}2`;
    await pool.query(`UPDATE workers SET phone = $2 WHERE id = $1`, [activeWorkerId, phoneActive]);
    await pool.query(`UPDATE workers SET phone = $2 WHERE id = $1`, [disabledWorkerId, phoneDisabled]);

    const res = await api.post('/api/admin/messaging/bulk-dispatch-incomplete?dryRun=true', {}, auth());
    expect(res.status).toBe(200);
    const ids = (res.data.data.details as Array<{ workerId: string }>).map((d) => d.workerId);
    expect(ids).toContain(activeWorkerId);
    expect(ids).not.toContain(disabledWorkerId);

    await pool.query(`UPDATE workers SET phone = NULL WHERE id = ANY($1::uuid[])`, [
      [activeWorkerId, disabledWorkerId],
    ]);
  });

  it('busca do painel: some por padrão, mas ?status=DISABLED continua achando', async () => {
    const semFiltro = await api.get('/api/admin/workers?limit=200', auth());
    expect(semFiltro.status).toBe(200);
    const idsSemFiltro = (semFiltro.data.data as Array<{ id: string }>).map((w) => w.id);
    expect(idsSemFiltro).not.toContain(disabledWorkerId);

    // Sem essa exceção o admin não teria como achar a pessoa para REVERTER a baixa.
    const comFiltro = await api.get('/api/admin/workers?limit=200&status=DISABLED', auth());
    expect(comFiltro.status).toBe(200);
    const idsComFiltro = (comFiltro.data.data as Array<{ id: string }>).map((w) => w.id);
    expect(idsComFiltro).toContain(disabledWorkerId);
    expect(idsComFiltro).not.toContain(activeWorkerId);
  });

  it('a baixa é reversível: reativando o worker, ele volta a aparecer', async () => {
    // INCOMPLETE_REGISTER, não REGISTERED: o trigger do banco recusa promover a
    // REGISTERED sem os campos obrigatórios ("Campos obrigatórios incompletos").
    // É também o estado real de quem dá baixa antes de completar o cadastro.
    await pool.query(`UPDATE workers SET status = 'INCOMPLETE_REGISTER' WHERE id = $1`, [
      disabledWorkerId,
    ]);

    const res = await api.get(`/api/admin/vacancies/${vacancyId}/funnel-table`, auth());
    const ids = (res.data.data.rows as Array<{ workerId: string }>).map((r) => r.workerId);

    expect(ids).toContain(disabledWorkerId);
    expect(res.data.data.counts.ALL).toBe(2);

    await pool.query(`UPDATE workers SET status = 'DISABLED' WHERE id = $1`, [disabledWorkerId]);
  });
});
