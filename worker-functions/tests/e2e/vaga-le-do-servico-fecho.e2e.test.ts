/**
 * vaga-le-do-servico-fecho.e2e.test.ts @integration — F8 de `vaga-le-do-servico-contratado` (e2e de FECHO, por API).
 *
 * API real (Docker) + Postgres real, HTTP de verdade. A fonte única provada de ponta a ponta:
 *   horário, quantidade de prestadores e faixa etária de uma vaga que nasceu de um serviço contratado são LIDOS do
 *   serviço; as colunas `job_postings.schedule|providers_needed|age_range_min|age_range_max` ficam NULL e NUNCA
 *   são escritas por quem muda o serviço.
 *
 * O comportamento SOB TESTE vai sempre pela API (ativação, PATCH do serviço, PUT da vaga, GET admin, feed e detalhe
 * públicos, ack do aviso). SQL só monta o cenário: o paciente, a publicação da vaga (`is_draft=false` + `SEARCHING`;
 * o publish real fala com Talentum/Gemini, canal proibido em teste), o encerramento (`CLOSED`) e a vaga MANUAL.
 * Nenhuma fixture insere vaga COM serviço E valor próprio nas colunas migradas (a F7 cria um CHECK que proíbe isso).
 *
 * Cenários:
 *   1. ativação: a vaga nasce com as 3 colunas NULL e o GET admin devolve os valores do serviço;
 *   2. muda no serviço → GET admin, feed e detalhe públicos mostram o novo; as colunas da vaga seguem NULL;
 *   3. vaga publicada: cada mudança abre o aviso do campo, o ack fecha; rascunho não gera aviso;
 *   4. apagar horário/quantidade com vaga viva → 422 `details.field`; apagar a banda → 200 + aviso `age_range`;
 *   5. vaga MANUAL: o PUT muda os próprios campos e nenhum PATCH de serviço a afeta; vaga com serviço recusa o PUT;
 *   6. vaga encerrada (`CLOSED`): mostra o valor ATUAL do serviço depois de um PATCH, sem aviso.
 *
 * Nenhum canal real: nada aqui chama Gemini/Talentum/WordPress/WhatsApp/e-mail. Dado sintético, sem PII nem clínico.
 * A quantidade de prestadores NÃO sai no feed nem no detalhe público (só no GET admin): ela é afirmada só no admin.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'vls-fecho-e2e';

// dayOfWeek: 1 = lunes, 3 = miercoles, 5 = viernes (DAY_KEYS_ES, dateFormatters.ts)
const SCHEDULE_V1 = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
const SCHEDULE_V2 = [{ dayOfWeek: 3, startTime: '14:00', endTime: '18:00' }];
const SCHEDULE_V3 = [{ dayOfWeek: 5, startTime: '09:00', endTime: '13:00' }];
// O GET admin e o detalhe público devolvem o horário no formato da VAGA (`normalizeSchedule`), não o do serviço.
const GET_V1 = { lunes: [{ start: '08:00', end: '12:00' }] };
const GET_V2 = { miercoles: [{ start: '14:00', end: '18:00' }] };
const GET_V3 = { viernes: [{ start: '09:00', end: '13:00' }] };

const COLUNAS_MIGRADAS_NULAS = { schedule: null, providers_needed: null, age_range_min: null, age_range_max: null };

describe('Vaga lê do serviço contratado — fecho por API (vaga-le-do-servico-contratado, F8) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: StaffAuth;
  let caseSeq = 884100;

  async function limpar(): Promise<void> {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [`${TAG}-%`],
    );
    await pool.query(
      `DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [`${TAG}-%`],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TAG}-%`]);
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('vls-fecho-e2e-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  /** Paciente de funil + endereço + serviço (horário V1, 2 prestadores, banda AGE_20_30 = 20/29). Tudo pela API, menos o paciente. */
  async function seedServico(): Promise<{ patientId: string; serviceId: string; caseNumber: number }> {
    const caseNumber = caseSeq++;
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number, health_insurance_name)
       VALUES ($1, 'VagaLeServico', 'Fecho E2E', 'AR', 'PENDING_ADMISSION', $2, 'Particular') RETURNING id`,
      [`${TAG}-${caseNumber}`, caseNumber],
    )).rows[0].id;
    const addr = await api.post(
      `/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Av. Siempre Viva 742', address_type: 'primary' },
      asAdmin,
    );
    expect(addr.status).toBe(201);
    const svc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId: addr.data.data.id, schedule: SCHEDULE_V1, providersNeeded: 2, providerAgeBand: 'AGE_20_30' },
      asAdmin,
    );
    expect(svc.status).toBe(201);
    return { patientId, serviceId: svc.data.data.id as string, caseNumber };
  }

  /** Ativa o recrutamento (a vaga nasce em rascunho, `PENDING_ACTIVATION`). */
  async function ativar(patientId: string, serviceId: string): Promise<string> {
    const act = await api.post(`/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {}, asAdmin);
    expect(act.status).toBe(201);
    return act.data.data.vacancyId as string;
  }

  /** Publica por SQL (sem Talentum): fora do rascunho, em status público, com o short link que o feed exige. */
  async function publicar(vacancyId: string): Promise<void> {
    await pool.query(
      `UPDATE job_postings
          SET is_draft = false, status = 'SEARCHING', talentum_description = 'AT con experiencia — F8 e2e.',
              social_short_links = $2::jsonb
        WHERE id = $1`,
      [vacancyId, JSON.stringify({ site: `https://srt.io/${TAG}-${vacancyId}` })],
    );
  }

  async function seedPublicada(): Promise<{ patientId: string; serviceId: string; vacancyId: string }> {
    const { patientId, serviceId } = await seedServico();
    const vacancyId = await ativar(patientId, serviceId);
    await publicar(vacancyId);
    return { patientId, serviceId, vacancyId };
  }

  const patchServico = (patientId: string, serviceId: string, body: Record<string, unknown>) =>
    api.patch(`/api/admin/patients/${patientId}/contracted-services/${serviceId}`, body, asAdmin);

  async function getAdmin(vacancyId: string): Promise<Record<string, any>> {
    const r = await api.get(`/api/admin/vacancies/${vacancyId}`, asAdmin);
    expect(r.status).toBe(200);
    return r.data.data;
  }

  async function colunasDaVaga(vacancyId: string): Promise<Record<string, unknown>> {
    return (await pool.query(
      `SELECT schedule, providers_needed, age_range_min, age_range_max FROM job_postings WHERE id = $1`,
      [vacancyId],
    )).rows[0];
  }

  const camposDosAvisos = (d: Record<string, any>): string[] => d.source_change_notices.map((n: { field: string }) => n.field);

  async function noFeed(vacancyId: string): Promise<Record<string, any> | undefined> {
    const feed = await api.get('/api/public/v1/jobs?country=AR');
    expect(feed.status).toBe(200);
    return (feed.data.data as Array<Record<string, any>>).find((j) => j.id === vacancyId);
  }

  it('1. ativação: a vaga nasce com as 3 colunas NULL e o GET admin devolve os valores do serviço', async () => {
    const { patientId, serviceId } = await seedServico();
    const vacancyId = await ativar(patientId, serviceId);

    expect(await colunasDaVaga(vacancyId)).toEqual(COLUNAS_MIGRADAS_NULAS);

    const d = await getAdmin(vacancyId);
    expect(d.contracted_service_id).toBe(serviceId);
    expect(d.schedule).toEqual(GET_V1);
    expect(d.providers_needed).toBe('2'); // TEXT: o formato da vaga, não o INT do serviço
    expect(d.age_range_min).toBe(20); // AGE_20_30 → 20/29
    expect(d.age_range_max).toBe(29);
    expect(d.source_change_notices).toEqual([]);
  });

  it('2. muda no serviço, lê no feed e no detalhe públicos, SEM escrita na vaga', async () => {
    const { patientId, serviceId, vacancyId } = await seedPublicada();

    // Controle positivo: o instrumento enxerga a vaga publicada com o valor ORIGINAL (senão o "mudou" abaixo não prova nada).
    const feedAntes = await noFeed(vacancyId);
    expect(feedAntes).toBeDefined();
    expect(feedAntes!.schedule_week.days.lunes).toEqual([{ start: '08:00', end: '12:00' }]);
    expect([feedAntes!.age_range_min, feedAntes!.age_range_max]).toEqual([20, 29]);

    const patch = await patchServico(patientId, serviceId, {
      schedule: SCHEDULE_V2,
      providersNeeded: 3,
      providerAgeBand: 'AGE_45_PLUS', // → 45 / sem teto
    });
    expect(patch.status).toBe(200);

    const admin = await getAdmin(vacancyId);
    expect(admin.schedule).toEqual(GET_V2);
    expect(admin.providers_needed).toBe('3');
    expect([admin.age_range_min, admin.age_range_max]).toEqual([45, null]);

    const feed = await noFeed(vacancyId);
    expect(feed).toBeDefined();
    expect(feed!.schedule_week.days.miercoles).toEqual([{ start: '14:00', end: '18:00' }]);
    expect(feed!.schedule_week.days.lunes).toEqual([]); // o horário antigo SUMIU do feed
    expect(feed!.schedule_days_hours).toBe('Miércoles 14:00-18:00');
    expect([feed!.age_range_min, feed!.age_range_max]).toEqual([45, null]);

    const detalhe = await api.get(`/api/vacancies/${vacancyId}`);
    expect(detalhe.status).toBe(200);
    expect(detalhe.data.data.schedule).toEqual(GET_V2);
    expect([detalhe.data.data.age_range_min, detalhe.data.data.age_range_max]).toEqual([45, null]);

    // O coração: ninguém escreveu na vaga. Se uma cópia voltar (escritor ou trigger), uma destas colunas deixa de ser NULL.
    expect(await colunasDaVaga(vacancyId)).toEqual(COLUNAS_MIGRADAS_NULAS);
  });

  it('3. vaga publicada: cada mudança abre o aviso do SEU campo e o ack fecha; ack repetido = 404', async () => {
    const { patientId, serviceId, vacancyId } = await seedPublicada();
    expect(camposDosAvisos(await getAdmin(vacancyId))).toEqual([]);

    const ack = (field: string) => api.post(`/api/admin/vacancies/${vacancyId}/source-change-notices/${field}/ack`, {}, asAdmin);
    const casos: Array<[string, Record<string, unknown>]> = [
      ['schedule', { schedule: SCHEDULE_V2 }],
      ['providers_needed', { providersNeeded: 3 }],
      ['age_range', { providerAgeBand: 'AGE_45_PLUS' }], // 20/29 → 45/null: a FAIXA derivada mudou
    ];
    for (const [field, body] of casos) {
      expect((await patchServico(patientId, serviceId, body)).status).toBe(200);
      expect(camposDosAvisos(await getAdmin(vacancyId))).toEqual([field]); // só o campo mudado, um por vez
      const fechou = await ack(field);
      expect(fechou.status).toBe(200);
      expect(fechou.data.success).toBe(true);
      expect(await getAdmin(vacancyId).then(camposDosAvisos)).toEqual([]);
    }
    expect((await ack('schedule')).status).toBe(404); // nada aberto
    expect(await colunasDaVaga(vacancyId)).toEqual(COLUNAS_MIGRADAS_NULAS);
  });

  it('3b. rascunho (recém-ativada, nunca publicada) NÃO gera aviso, mesmo mudando os 3 campos', async () => {
    const { patientId, serviceId } = await seedServico();
    const vacancyId = await ativar(patientId, serviceId);
    const patch = await patchServico(patientId, serviceId, { schedule: SCHEDULE_V2, providersNeeded: 3, providerAgeBand: 'AGE_30_45' });
    expect(patch.status).toBe(200);
    const d = await getAdmin(vacancyId);
    expect(d.source_change_notices).toEqual([]);
    expect(d.schedule).toEqual(GET_V2); // e a vaga em rascunho já lê o valor novo
  });

  it('4. apagar horário ou quantidade com vaga viva → 422 com o campo; apagar a banda → 200 + aviso age_range', async () => {
    const { patientId, serviceId, vacancyId } = await seedPublicada();

    for (const body of [{ schedule: [] }, { schedule: null }]) {
      const r = await patchServico(patientId, serviceId, body);
      expect(r.status).toBe(422);
      expect(r.data.code).toBe('SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY');
      expect(r.data.details.field).toBe('schedule');
      expect(r.data.details.vacancyIds).toContain(vacancyId);
    }
    const semQuantidade = await patchServico(patientId, serviceId, { providersNeeded: null });
    expect(semQuantidade.status).toBe(422);
    expect(semQuantidade.data.code).toBe('SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY');
    expect(semQuantidade.data.details.field).toBe('providers_needed');

    // A recusa não escreveu nada: nem no serviço, nem aviso, e a vaga segue lendo o valor original.
    const svc = (await pool.query(`SELECT schedule, providers_needed FROM patient_contracted_services WHERE id = $1`, [serviceId])).rows[0];
    expect(svc).toEqual({ schedule: SCHEDULE_V1, providers_needed: 2 });
    const intacta = await getAdmin(vacancyId);
    expect(intacta.schedule).toEqual(GET_V1);
    expect(intacta.providers_needed).toBe('2');
    expect(intacta.source_change_notices).toEqual([]);

    // A banda vazia é estado normal do produto: apagar é permitido, a faixa vira "sem filtro" e o aviso abre.
    const semBanda = await patchServico(patientId, serviceId, { providerAgeBand: null });
    expect(semBanda.status).toBe(200);
    const depois = await getAdmin(vacancyId);
    expect([depois.age_range_min, depois.age_range_max]).toEqual([null, null]);
    expect(camposDosAvisos(depois)).toEqual(['age_range']);
    expect((await pool.query(`SELECT provider_age_band FROM patient_contracted_services WHERE id = $1`, [serviceId])).rows[0].provider_age_band).toBeNull();
    expect(await colunasDaVaga(vacancyId)).toEqual(COLUNAS_MIGRADAS_NULAS);
  });

  it('4b. a recusa vale também para a vaga em RASCUNHO (viva = não apagada e fora de CLOSED/DE_BAJA)', async () => {
    const { patientId, serviceId } = await seedServico();
    await ativar(patientId, serviceId); // PENDING_ACTIVATION, is_draft = true
    const r = await patchServico(patientId, serviceId, { schedule: [] });
    expect(r.status).toBe(422);
    expect(r.data.details.field).toBe('schedule');
  });

  it('5. vaga MANUAL é dona dos próprios campos: o PUT muda, nenhum PATCH de serviço a afeta; vaga com serviço recusa o PUT', async () => {
    const { patientId, serviceId, caseNumber } = await seedServico(); // serviço do MESMO paciente, sem vaga ligada a ele
    // Vaga manual (sem contracted_service_id): rascunho de teste (is_test evita o short link em terceiro no pós-PUT).
    const manualId = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, case_number, patient_id, status, is_draft, required_professions, country, is_test)
       VALUES ($1, $2, $3, 'SEARCHING', true, ARRAY['AT'], 'AR', true) RETURNING id`,
      [`CASO ${caseNumber} manual`, caseNumber, patientId],
    )).rows[0].id;

    const put = await api.put(
      `/api/admin/vacancies/${manualId}`,
      { schedule: SCHEDULE_V3, providers_needed: '3', age_range_min: 25, age_range_max: 40 },
      asAdmin,
    );
    expect(put.status).toBe(200);

    // Aqui, e só aqui, a coluna da vaga É o dado.
    const colunas = await colunasDaVaga(manualId);
    expect(colunas).toEqual({ schedule: SCHEDULE_V3, providers_needed: '3', age_range_min: 25, age_range_max: 40 });
    const antes = await getAdmin(manualId);
    expect(antes.schedule).toEqual(GET_V3);
    expect(antes.providers_needed).toBe('3');
    expect([antes.age_range_min, antes.age_range_max]).toEqual([25, 40]);
    expect(antes.locked_fields).toEqual([]);

    // O serviço do paciente muda os 3 campos: a vaga manual não é vaga DESSE serviço e nada muda nela.
    const patch = await patchServico(patientId, serviceId, { schedule: SCHEDULE_V2, providersNeeded: 5, providerAgeBand: 'AGE_45_PLUS' });
    expect(patch.status).toBe(200);
    const depois = await getAdmin(manualId);
    expect(depois.schedule).toEqual(GET_V3);
    expect(depois.providers_needed).toBe('3');
    expect([depois.age_range_min, depois.age_range_max]).toEqual([25, 40]);
    expect(depois.source_change_notices).toEqual([]);
    expect(await colunasDaVaga(manualId)).toEqual(colunas);

    // Contraste: a vaga que nasceu de um serviço NÃO aceita escrever o horário (campo travado pela origem).
    const outra = await seedPublicada();
    const recusa = await api.put(`/api/admin/vacancies/${outra.vacancyId}`, { schedule: SCHEDULE_V3 }, asAdmin);
    expect(recusa.status).toBe(422);
    expect(recusa.data.locked_fields).toContain('schedule');
    expect(await colunasDaVaga(outra.vacancyId)).toEqual(COLUNAS_MIGRADAS_NULAS);
  });

  it('6. vaga encerrada (CLOSED) mostra o valor ATUAL do serviço depois de um PATCH, sem aviso', async () => {
    const { patientId, serviceId, vacancyId } = await seedPublicada();
    await pool.query(`UPDATE job_postings SET status = 'CLOSED' WHERE id = $1`, [vacancyId]); // arranjo: o encerramento em si não está sob teste

    const patch = await patchServico(patientId, serviceId, { schedule: SCHEDULE_V2, providersNeeded: 4, providerAgeBand: 'AGE_30_45' });
    expect(patch.status).toBe(200); // sem vaga viva, nada recusa

    const d = await getAdmin(vacancyId);
    expect(d.status).toBe('CLOSED');
    expect(d.schedule).toEqual(GET_V2);
    expect(d.providers_needed).toBe('4');
    expect([d.age_range_min, d.age_range_max]).toEqual([30, 44]);
    expect(d.source_change_notices).toEqual([]); // encerrada não recebe aviso
    expect(await colunasDaVaga(vacancyId)).toEqual(COLUNAS_MIGRADAS_NULAS);
  });
});
