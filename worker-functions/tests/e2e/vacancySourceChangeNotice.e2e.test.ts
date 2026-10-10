/**
 * Aviso na vaga publicada quando o horário do serviço muda (change `vaga-le-do-servico-contratado`, F3) —
 * banco REAL, sessão `app_runtime` com identidade (AR), RLS ativa; o caminho é o de produção:
 * `PatientContractedServiceRepository.update` (PATCH do serviço) → `vacancy_source_change_notices`
 * → `VacanciesController.getVacancyById` (GET) → `VacancySourceChangeNoticeController.acknowledge` (ack).
 *
 * Roda no CI pelo `npm run test:e2e` (jest.config.e2e.js). Nenhum canal real: nada aqui chama Gemini/Talentum/WhatsApp.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { PatientContractedServiceRepository } from '../../src/modules/case/infrastructure/PatientContractedServiceRepository';
import { VacanciesController } from '../../src/modules/matching/interfaces/controllers/VacanciesController';
import { VacancySourceChangeNoticeController } from '../../src/modules/matching/interfaces/controllers/VacancySourceChangeNoticeController';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const UID = 'vls-f3-staff-uid';
const TAG = 'vls-f3';

const SCHEDULE_A = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
const SCHEDULE_AB = [
  { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
  { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' },
];
const SCHEDULE_AB_REORDERED = [
  { endTime: '18:00', startTime: '14:00', dayOfWeek: 3 },
  { endTime: '12:00', startTime: '08:00', dayOfWeek: 1 },
];
const SCHEDULE_X = [{ dayOfWeek: 3, startTime: '14:15', endTime: '18:45' }];

let admin: Pool;
let identityPool: Pool;
let caseSeq = 930000;

interface Ctx { patientId: string; serviceId: string; vacancyIds: string[] }

const repo = () => new PatientContractedServiceRepository({ listForService: async () => [] } as never);
const patchSchedule = (ctx: Ctx, schedule: unknown) =>
  repo().update(ctx.serviceId, { schedule: schedule as never, actorUid: UID });

function mockRes() {
  const res: { statusCode: number; body: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    body: undefined,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}
const asReq = (r: Record<string, unknown>) => ({ headers: {}, query: {}, params: {}, body: {}, ...r }) as never;
const asRes = (r: unknown) => r as never;

interface VacancyOpts { draft?: boolean; status?: string; deleted?: boolean }

/** Paciente + serviço (horário A) + N vagas vinculadas. Sem `vacancies` = serviço sem nenhuma vaga. */
async function seed(vacancies: VacancyOpts[], serviceSchedule: unknown = SCHEDULE_A): Promise<Ctx> {
  const patientId = randomUUID();
  const addressId = randomUUID();
  const serviceId = randomUUID();
  const caseNumber = caseSeq++;
  await admin.query(
    `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, case_number)
     VALUES ($1, $2, 'Paciente', 'Aviso Vaga', 'AR', $3)`,
    [patientId, `${TAG}-${patientId}`, caseNumber],
  );
  await admin.query(
    `INSERT INTO patient_addresses (id, patient_id, country, address_formatted, city, state)
     VALUES ($1, $2, 'AR', 'Av. Corrientes 1234, CABA', 'CABA', 'Buenos Aires')`,
    [addressId, patientId],
  );
  await admin.query(
    `INSERT INTO patient_contracted_services (id, patient_id, service_code, country, created_by, updated_by, schedule, providers_needed, address_id)
     VALUES ($1, $2, 'AT', 'AR', $3, $3, $4::jsonb, 1, $5)`,
    [serviceId, patientId, TAG, JSON.stringify(serviceSchedule), addressId],
  );
  const vacancyIds: string[] = [];
  for (const [i, v] of vacancies.entries()) {
    const id = randomUUID();
    vacancyIds.push(id);
    await admin.query(
      `INSERT INTO job_postings (id, title, case_number, patient_id, patient_address_id, contracted_service_id,
                                 status, is_draft, deleted_at, required_professions, country, is_test, providers_needed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY['AT'], 'AR', false, '1')`,
      [id, `CASO ${caseNumber} #${i}`, caseNumber, patientId, addressId, serviceId,
        v.status ?? 'SEARCHING', v.draft ?? false, v.deleted ? new Date() : null],
    );
  }
  return { patientId, serviceId, vacancyIds };
}

const notices = (jobPostingId?: string) =>
  admin.query<{ job_posting_id: string; field: string; changed_at: Date; acknowledged_at: Date | null; acknowledged_by: string | null }>(
    `SELECT job_posting_id, field, changed_at, acknowledged_at, acknowledged_by
       FROM vacancy_source_change_notices
      WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE 'CASO 93%')
        AND ($1::uuid IS NULL OR job_posting_id = $1::uuid)
      ORDER BY changed_at, acknowledged_at NULLS LAST`,
    [jobPostingId ?? null],
  );

async function wipe(): Promise<void> {
  await admin.query(`DELETE FROM job_postings WHERE title LIKE 'CASO 93%'`); // cascata: avisos
  await admin.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${TAG}-%'`); // cascata: endereços e serviços
}

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  identityPool = new Pool({
    connectionString: ADMIN_URL,
    options: `-c role=app_runtime -c app.user_country=AR -c app.user_uid=${UID}`,
    max: 4,
  });
  // `query` e `connect` COM identidade: o `withActorContext` do PATCH carrega identidade em produção (ALS) e aqui ela
  // vem da sessão. O que se prova é o GRANT/DML do aviso como `app_runtime`, não o roteamento do pool (F1/F2).
  jest.spyOn(DatabaseConnection, 'getInstance').mockReturnValue({
    getPool: () => identityPool,
    getRawPool: () => identityPool,
    getSystemPool: () => identityPool,
    getClient: () => identityPool.connect(),
  } as never);
  await wipe();
});

afterAll(async () => {
  await wipe();
  await Promise.all([admin.end(), identityPool.end()]);
});

beforeEach(wipe);

describe('vacancySourceChangeNotice (e2e, app_runtime, banco real)', () => {
  it('a sessão sob teste é app_runtime com identidade AR, não a dona', async () => {
    const r = await identityPool.query(`SELECT current_user, current_setting('app.user_country', true) AS country`);
    expect(r.rows[0]).toEqual({ current_user: 'app_runtime', country: 'AR' });
  });

  it('muda + publicada viva = 1 aviso (campo schedule, aberto)', async () => {
    const ctx = await seed([{}]);
    await patchSchedule(ctx, SCHEDULE_X);
    const n = await notices();
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]).toMatchObject({ job_posting_id: ctx.vacancyIds[0], field: 'schedule', acknowledged_at: null, acknowledged_by: null });
  });

  it('o aviso NÃO guarda valor: a tabela só tem id, vaga, campo, changed_at e ack', async () => {
    const cols = await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'vacancy_source_change_notices' ORDER BY column_name`);
    expect(cols.rows.map((c) => c.column_name)).toEqual(['acknowledged_at', 'acknowledged_by', 'changed_at', 'field', 'id', 'job_posting_id']);
  });

  it('uma linha por vaga publicada viva (2 vivas = 2 avisos)', async () => {
    const ctx = await seed([{}, { status: 'ACTIVE' }]);
    await patchSchedule(ctx, SCHEDULE_X);
    const n = await notices();
    expect(n.rows.map((r) => r.job_posting_id).sort()).toEqual([...ctx.vacancyIds].sort());
  });

  it('valor igual = 0 aviso (mesmo conteúdo reenviado)', async () => {
    const ctx = await seed([{}]);
    await patchSchedule(ctx, [{ ...SCHEDULE_A[0] }]);
    expect((await notices()).rows).toHaveLength(0);
  });

  it('valor igual com os slots em OUTRA ordem = 0 aviso', async () => {
    const ctx = await seed([{}], SCHEDULE_AB);
    await patchSchedule(ctx, SCHEDULE_AB_REORDERED);
    expect((await notices()).rows).toHaveLength(0);
  });

  it('só rascunho = 0 aviso', async () => {
    const ctx = await seed([{ draft: true }]);
    await patchSchedule(ctx, SCHEDULE_X);
    expect((await notices()).rows).toHaveLength(0);
  });

  it('sem vaga = 0 aviso (e o PATCH grava o horário do mesmo jeito)', async () => {
    const ctx = await seed([]);
    await patchSchedule(ctx, SCHEDULE_X);
    expect((await notices()).rows).toHaveLength(0);
    const svc = await admin.query(`SELECT schedule FROM patient_contracted_services WHERE id = $1`, [ctx.serviceId]);
    expect(svc.rows[0].schedule).toEqual(SCHEDULE_X);
  });

  it.each([
    ['CLOSED', { status: 'CLOSED' }],
    ['DE_BAJA', { status: 'DE_BAJA' }],
    ['apagada (deleted_at)', { deleted: true }],
  ] as const)('vaga encerrada (%s) = 0 aviso', async (_nome, opts) => {
    const ctx = await seed([opts]);
    await patchSchedule(ctx, SCHEDULE_X);
    expect((await notices()).rows).toHaveLength(0);
  });

  it('mistura: só a vaga publicada viva recebe aviso (rascunho e encerrada ao lado ficam sem)', async () => {
    const ctx = await seed([{ draft: true }, {}, { status: 'CLOSED' }]);
    await patchSchedule(ctx, SCHEDULE_X);
    const n = await notices();
    expect(n.rows.map((r) => r.job_posting_id)).toEqual([ctx.vacancyIds[1]]);
  });

  it('2ª mudança com aviso aberto atualiza o MESMO aviso (1 linha, changed_at avança)', async () => {
    const ctx = await seed([{}]);
    await patchSchedule(ctx, SCHEDULE_X);
    const first = (await notices()).rows[0];
    await new Promise((r) => setTimeout(r, 15));
    await patchSchedule(ctx, SCHEDULE_AB);
    const after = (await notices()).rows;
    expect(after).toHaveLength(1);
    expect(after[0].changed_at.getTime()).toBeGreaterThan(first.changed_at.getTime());
  });

  it('índice único parcial: 2º aviso aberto da mesma vaga+campo não entra; depois do ack, um novo entra', async () => {
    const ctx = await seed([{}]);
    const vac = ctx.vacancyIds[0];
    await admin.query(`INSERT INTO vacancy_source_change_notices (job_posting_id, field) VALUES ($1, 'schedule')`, [vac]);
    await expect(admin.query(`INSERT INTO vacancy_source_change_notices (job_posting_id, field) VALUES ($1, 'schedule')`, [vac]))
      .rejects.toMatchObject({ code: '23505', constraint: 'uq_vscn_open_per_vacancy_field' });
    // outro campo da mesma vaga é outro aviso
    await admin.query(`INSERT INTO vacancy_source_change_notices (job_posting_id, field) VALUES ($1, 'age_range')`, [vac]);
    await admin.query(`UPDATE vacancy_source_change_notices SET acknowledged_at = now(), acknowledged_by = 'x' WHERE job_posting_id = $1 AND field = 'schedule'`, [vac]);
    await admin.query(`INSERT INTO vacancy_source_change_notices (job_posting_id, field) VALUES ($1, 'schedule')`, [vac]);
    const open = await admin.query(`SELECT count(*)::int AS n FROM vacancy_source_change_notices WHERE job_posting_id = $1 AND field = 'schedule' AND acknowledged_at IS NULL`, [vac]);
    expect(open.rows[0].n).toBe(1);
    await expect(admin.query(`INSERT INTO vacancy_source_change_notices (job_posting_id, field) VALUES ($1, 'preço')`, [vac]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('ack fecha o aviso (grava acknowledged_at/by); mudança seguinte abre um NOVO', async () => {
    const ctx = await seed([{}]);
    await patchSchedule(ctx, SCHEDULE_X);
    const res = mockRes();
    await new VacancySourceChangeNoticeController().acknowledge(
      asReq({ params: { id: ctx.vacancyIds[0], field: 'schedule' }, user: { uid: UID } }), asRes(res));
    expect(res.statusCode).toBe(200);
    const closed = (await notices()).rows;
    expect(closed).toHaveLength(1);
    expect(closed[0].acknowledged_at).not.toBeNull();
    expect(closed[0].acknowledged_by).toBe(`staff:${UID}`);

    await patchSchedule(ctx, SCHEDULE_AB);
    const rows = (await notices()).rows;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.acknowledged_at === null)).toHaveLength(1);
  });

  it('ack sem aviso aberto = 404; ack com field inválido = 400 (nada alterado)', async () => {
    const ctx = await seed([{}]);
    const none = mockRes();
    await new VacancySourceChangeNoticeController().acknowledge(
      asReq({ params: { id: ctx.vacancyIds[0], field: 'schedule' }, user: { uid: UID } }), asRes(none));
    expect(none.statusCode).toBe(404);
    await patchSchedule(ctx, SCHEDULE_X);
    const bad = mockRes();
    await new VacancySourceChangeNoticeController().acknowledge(
      asReq({ params: { id: ctx.vacancyIds[0], field: 'address' }, user: { uid: UID } }), asRes(bad));
    expect(bad.statusCode).toBe(400);
    expect((await notices()).rows[0].acknowledged_at).toBeNull();
  });

  it('GET da vaga devolve só os avisos ABERTOS; `[]` quando não há', async () => {
    const ctx = await seed([{}]);
    const vac = ctx.vacancyIds[0];
    const get = async () => {
      const res = mockRes();
      await new VacanciesController({ listForPatient: async () => [] } as never).getVacancyById(asReq({ params: { id: vac } }), asRes(res));
      expect(res.statusCode).toBe(200);
      return (res.body as { data: { source_change_notices: Array<{ field: string; changed_at: string }> } }).data.source_change_notices;
    };
    expect(await get()).toEqual([]);

    await patchSchedule(ctx, SCHEDULE_X);
    await admin.query(`INSERT INTO vacancy_source_change_notices (job_posting_id, field, acknowledged_at, acknowledged_by) VALUES ($1, 'age_range', now(), 'x')`, [vac]);
    const abertos = await get();
    expect(abertos).toHaveLength(1);
    expect(abertos[0].field).toBe('schedule');
    expect(Object.keys(abertos[0]).sort()).toEqual(['changed_at', 'field']);

    const ack = mockRes();
    await new VacancySourceChangeNoticeController().acknowledge(asReq({ params: { id: vac, field: 'schedule' }, user: { uid: UID } }), asRes(ack));
    expect(await get()).toEqual([]);
  });

  it('PATCH sem o campo schedule (ex.: só providers_needed) = 0 aviso', async () => {
    const ctx = await seed([{}]);
    await repo().update(ctx.serviceId, { providersNeeded: 3, actorUid: UID } as never);
    expect((await notices()).rows).toHaveLength(0);
  });
});
