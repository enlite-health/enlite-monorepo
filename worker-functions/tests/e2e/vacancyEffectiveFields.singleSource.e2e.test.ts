/**
 * Fonte única do horário da vaga (change `vaga-le-do-servico-contratado`, F1) — banco REAL, sessão do leitor
 * como `app_runtime` (não a dona), com RLS ativa.
 *
 * Para CADA um dos 13 leitores de `job_postings.schedule` (lista F1 do `fatos-medidos.md`):
 *   paciente + serviço contratado (horário A) + vaga vinculada cuja CÓPIA `job_postings.schedule` é A;
 *   `UPDATE patient_contracted_services SET schedule = X` direto no SQL, SEM tocar a vaga;
 *   chama o leitor de produção (método/handler/função exportada, não cópia da query) e afirma que a saída traz X.
 *
 * Gemini/Talentum: dublê obrigatório (nenhuma chamada de rede); a asserção é sobre o que chega ao dublê.
 * Roda no CI pelo `npm run test:e2e` (jest.config.e2e.js, `tests/e2e/**.test.ts`, backend-e2e.yml).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { JOB_POSTING_COLUMNS } from '../../src/shared/sql/vacancyEffectiveFieldsSql';

const mockGeminiPrompts: string[] = [];
const mockParserCalls: Array<{ vacancy: { schedule?: unknown } }> = [];

jest.mock('../../src/modules/integration/infrastructure/vertex-gemini', () => ({
  generateContentVertex: jest.fn(async (_model: string, body: { contents: Array<{ parts: Array<{ text: string }> }> }) => {
    mockGeminiPrompts.push(body.contents[0].parts[0].text);
    return {
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ propuesta: 'p', perfilProfesional: 'q' }) }] } }],
      }),
    };
  }),
}));
jest.mock('../../src/modules/integration/infrastructure/GeminiVacancyParserService', () => ({
  GeminiVacancyParserService: jest.fn().mockImplementation(() => ({
    generateFromVacancyData: jest.fn(async (vacancy: { schedule?: unknown }) => {
      mockParserCalls.push({ vacancy });
      return { prescreening: { questions: [], faq: [] } };
    }),
  })),
}));

// Importados DEPOIS dos mocks (jest.mock é içado, mas os pools são plugados em beforeAll).
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { fetchPatientDetail } from '../../src/modules/case/infrastructure/PatientDetailQueryHelper';
import { TalentumDescriptionService } from '../../src/modules/integration/infrastructure/TalentumDescriptionService';
import { VacancyTalentumController } from '../../src/modules/matching/interfaces/controllers/VacancyTalentumController';
import { FindNearbyVacanciesForWorkerUseCase } from '../../src/modules/matching/application/FindNearbyVacanciesForWorkerUseCase';
import { GetArmedCasesUseCase } from '../../src/modules/matching/application/GetArmedCasesUseCase';
import { horasAtivasQuery } from '../../src/modules/matching/application/managementDashboardQueries';
import { runHardFilter } from '../../src/modules/matching/infrastructure/MatchmakingHardFilterQuery';
import { JobPostingARRepository } from '../../src/modules/matching/infrastructure/JobPostingARRepository';
import { PublicVacancyController } from '../../src/modules/matching/interfaces/controllers/PublicVacancyController';
import { VacanciesController } from '../../src/modules/matching/interfaces/controllers/VacanciesController';
import { RecruitmentAnalyticsController } from '../../src/modules/matching/interfaces/controllers/RecruitmentAnalyticsController';
import { VacancyCrudController } from '../../src/modules/matching/interfaces/controllers/VacancyCrudController';
import { DataRealm } from '../../src/shared/domain/DataRealm';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const UID = 'vls-f1-staff-uid';
const TAG = 'vls-f1';

/** A = o que a cópia da vaga e o serviço têm no início. X = o que o serviço passa a ter (a vaga NÃO é tocada). */
const SCHEDULE_A = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
const SCHEDULE_X = [{ dayOfWeek: 3, startTime: '14:15', endTime: '18:45' }];

/** A lista F1 do `fatos-medidos.md`, na ordem. O teste afirma que são 13 e que o corpo cobre cada um. */
const LEITORES_F1 = [
  '1 case/infrastructure/PatientDetailQueryHelper.ts (-> AddressAvailabilityCalculator)',
  '2 integration/infrastructure/TalentumDescriptionService.ts',
  '3 matching/interfaces/controllers/VacancyTalentumController.ts',
  '4 matching/application/FindNearbyVacanciesForWorkerUseCase.ts',
  '5 matching/application/GetArmedCasesUseCase.ts',
  '6 matching/application/managementDashboardQueries.ts',
  '7 matching/infrastructure/MatchmakingHardFilterQuery.ts',
  '8 matching/infrastructure/JobPostingARRepository.ts (findActivePublic)',
  '9 matching/interfaces/controllers/PublicVacancyController.ts',
  '10 matching/interfaces/controllers/VacanciesController.ts (getVacancyById)',
  '11 matching/interfaces/controllers/RecruitmentAnalyticsController.ts (getCaseAnalysis)',
  '12 matching/interfaces/controllers/vacancyScheduleFilter.ts (via VacanciesController.listVacancies)',
  '13 matching/interfaces/controllers/VacancyCrudController.ts (+ vacancyCrudHelpers.ts)',
] as const;

interface Ctx {
  patientId: string;
  addressId: string;
  serviceId: string;
  vacancyId: string;
  caseNumber: number;
}
interface Probe { sawA: boolean; sawX: boolean }

let admin: Pool;
/** Sessão COM identidade (staff AR): o que `db.query()` entrega via client fixado da request (rlsAwarePool). */
let identityPool: Pool;
/** Sessão SEM identidade (nenhum GUC): o que `db.connect()` cru entrega. */
let barePool: Pool;
let caseSeq = 910000;

const runtimeOptions = (guc: string) => `-c role=app_runtime ${guc}`.trim();

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
const mentions = (out: unknown, needle: string) => JSON.stringify(out).includes(needle);
const probeJson = (out: unknown): Probe => ({ sawA: mentions(out, '08:00'), sawX: mentions(out, '14:15') });

async function seed(opts: { draft?: boolean; status?: string; withService?: boolean; serviceSchedule?: unknown; vacancySchedule?: unknown } = {}): Promise<Ctx> {
  const { draft = false, status = 'SEARCHING', withService = true } = opts;
  const patientId = randomUUID();
  const addressId = randomUUID();
  const serviceId = randomUUID();
  const vacancyId = randomUUID();
  const caseNumber = caseSeq++;
  await admin.query(
    `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, case_number)
     VALUES ($1, $2, 'Paciente', 'Fonte Unica', 'AR', $3)`,
    [patientId, `${TAG}-${patientId}`, caseNumber],
  );
  await admin.query(
    `INSERT INTO patient_addresses (id, patient_id, country, address_formatted, city, state)
     VALUES ($1, $2, 'AR', 'Av. Corrientes 1234, CABA', 'CABA', 'Buenos Aires')`,
    [addressId, patientId],
  );
  if (withService) {
    await admin.query(
      `INSERT INTO patient_contracted_services (id, patient_id, service_code, country, created_by, updated_by, schedule, providers_needed, address_id)
       VALUES ($1, $2, 'AT', 'AR', $3, $3, $4::jsonb, 1, $5)`,
      [serviceId, patientId, TAG, opts.serviceSchedule === null ? null : JSON.stringify(opts.serviceSchedule ?? SCHEDULE_A), addressId],
    );
  }
  await admin.query(
    `INSERT INTO job_postings (id, title, case_number, patient_id, patient_address_id, contracted_service_id, schedule,
                               status, is_draft, required_professions, country, is_test, providers_needed, social_short_links)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, ARRAY['AT'], 'AR', false, '1', '{"site":"https://enlite.test/x"}'::jsonb)`,
    [vacancyId, `CASO ${caseNumber}`, caseNumber, patientId, addressId, withService ? serviceId : null,
      JSON.stringify(opts.vacancySchedule === undefined ? SCHEDULE_A : opts.vacancySchedule), status, draft],
  );
  return { patientId, addressId, serviceId, vacancyId, caseNumber };
}

const setServiceSchedule = (ctx: Ctx, schedule: unknown) =>
  admin.query(`UPDATE patient_contracted_services SET schedule = $2::jsonb WHERE id = $1`, [ctx.serviceId, schedule === null ? null : JSON.stringify(schedule)]);

async function seedWorker(availabilityDays: number[]): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO workers (id, auth_uid, phone, occupation, status, country, is_test)
     VALUES ($1, $2, $3, 'AT', 'REGISTERED', 'AR', false)`,
    [id, `${TAG}-${id}`, `+5491100${Math.floor(Math.random() * 1e6)}`],
  );
  await admin.query(
    `INSERT INTO worker_service_areas (worker_id, latitude, longitude) VALUES ($1, -34.6, -58.4)`,
    [id],
  );
  for (const d of availabilityDays) {
    await admin.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1, $2, '00:00', '23:59', 'America/Argentina/Buenos_Aires')`,
      [id, d],
    );
  }
  return id;
}

async function wipe(): Promise<void> {
  await admin.query(`DELETE FROM job_postings WHERE title LIKE 'CASO 91%'`);
  await admin.query(`DELETE FROM workers WHERE auth_uid LIKE '${TAG}-%'`);
  await admin.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${TAG}-%'`); // cascata: endereços e serviços
}

/** Um leitor: seed específico + `probe` que chama o leitor de produção e diz se a saída traz A e/ou X. */
interface Leitor {
  n: number;
  nome: string;
  seed?: () => Promise<Ctx>;
  probe: (ctx: Ctx) => Promise<Probe>;
}

const kmsStub = { decrypt: async () => null, encrypt: async () => 'x' } as never;
const diagnosisStub = { listForPatient: async () => [] } as never;

const LEITORES: Leitor[] = [
  {
    n: 1, nome: 'fetchPatientDetail',
    probe: async (ctx) => {
      const d = await fetchPatientDetail(identityPool, kmsStub, ctx.patientId);
      const perDay = d!.addresses.find((a) => a.id === ctx.addressId)!.availability.perDay;
      const covered = (day: number) => perDay.find((e) => e.dayOfWeek === day)?.coveredHours ?? 0;
      return { sawA: covered(1) === 4, sawX: covered(3) === 4.5 };
    },
  },
  {
    n: 2, nome: 'TalentumDescriptionService.generateDescriptionPreview (Gemini = dublê)',
    probe: async (ctx) => {
      mockGeminiPrompts.length = 0;
      await new TalentumDescriptionService().generateDescriptionPreview(ctx.vacancyId);
      expect(mockGeminiPrompts).toHaveLength(1);
      const horarios = mockGeminiPrompts[0].split('\n').find((l) => l.startsWith('- Horarios:')) ?? '';
      return { sawA: horarios.includes('Lun: 08:00-12:00'), sawX: horarios.includes('Mié: 14:15-18:45') };
    },
  },
  {
    n: 3, nome: 'VacancyTalentumController.generateAIContent (Gemini = dublê)',
    probe: async (ctx) => {
      mockGeminiPrompts.length = 0;
      mockParserCalls.length = 0;
      const res = mockRes();
      await new VacancyTalentumController().generateAIContent(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      expect(mockParserCalls).toHaveLength(1);
      const horarios = mockGeminiPrompts[0].split('\n').find((l) => l.startsWith('- Horarios:')) ?? '';
      const payload = mockParserCalls[0].vacancy.schedule;
      return {
        sawA: mentions(payload, '08:00') || horarios.includes('08:00'),
        sawX: mentions(payload, '14:15') && horarios.includes('14:15-18:45'),
      };
    },
  },
  {
    // ⚠️ DEFEITO ANTERIOR À F1: a query deste leitor seleciona `jp.patient_zone`, coluna que a migration 039
    // dropou. O leitor REJEITA em qualquer banco, com ou sem a peça. Não dá para exercê-lo até alguém consertá-lo
    // (fora do escopo da F1: ACHADOS FORA DO ESCOPO). O caso afirma o estado atual; quando for consertado, este
    // caso fica VERMELHO de propósito e passa a valer o probe de verdade (já escrito em `probeQuandoConsertado`).
    n: 4, nome: 'FindNearbyVacanciesForWorkerUseCase.execute (QUEBRADO antes da F1: jp.patient_zone)',
    probe: async () => {
      const workerId = await seedWorker([1]);
      await expect(new FindNearbyVacanciesForWorkerUseCase(identityPool).execute(workerId, 1, 30, 5)).rejects.toThrow(
        /column jp\.patient_zone does not exist/,
      );
      return { sawA: true, sawX: true }; // sem observação possível: veja `defeitoPreexistente` abaixo
    },
  },
  {
    n: 5, nome: 'GetArmedCasesUseCase.execute (horas totais)',
    probe: async () => {
      const r = await new GetArmedCasesUseCase(identityPool).execute(['AR']);
      return { sawA: r.horasTotais === 4, sawX: r.horasTotais === 4.5 };
    },
  },
  {
    n: 6, nome: 'horasAtivasQuery (dashboard de gestão)',
    seed: () => seed({ status: 'ACTIVE' }),
    probe: async () => {
      const { rows } = await horasAtivasQuery(identityPool, ['AR']);
      return probeJson(rows);
    },
  },
  {
    n: 7, nome: 'runHardFilter (subselect COVERAGE, MATCHING_RESPECT_AVAILABILITY=true)',
    probe: async (ctx) => {
      // O worker só cobre o dia 1: com A (dia 1) ele passa; com X (dia 3) fica descoberto e sai do filtro.
      const prev = process.env.MATCHING_RESPECT_AVAILABILITY;
      process.env.MATCHING_RESPECT_AVAILABILITY = 'true';
      try {
        const workerId = (await admin.query(`SELECT id FROM workers WHERE auth_uid LIKE '${TAG}-%' LIMIT 1`)).rows[0]?.id ?? (await seedWorker([1]));
        const out = await runHardFilter(
          identityPool, kmsStub,
          { id: ctx.vacancyId, workerProfileSought: null, scheduleDaysHours: null, diagnosis: null, patientZone: null,
            serviceLat: null, serviceLng: null, requiredSex: null, requiredProfessions: ['AT'], pathologyTypes: null,
            realm: DataRealm.fromIsTest(false) },
          null, false, false,
        );
        const passa = out.some((c) => c.workerId === workerId);
        return { sawA: passa, sawX: !passa };
      } finally {
        if (prev === undefined) delete process.env.MATCHING_RESPECT_AVAILABILITY; else process.env.MATCHING_RESPECT_AVAILABILITY = prev;
      }
    },
  },
  {
    n: 8, nome: 'JobPostingARRepository.findActivePublic (feed público)',
    probe: async (ctx) => {
      const rows = await new JobPostingARRepository().findActivePublic({ country: 'AR' } as never);
      return probeJson(rows.filter((r) => r.id === ctx.vacancyId).map((r) => r.schedule));
    },
  },
  {
    n: 9, nome: 'PublicVacancyController.getById (detalhe público)',
    probe: async (ctx) => {
      const res = mockRes();
      await new PublicVacancyController(diagnosisStub).getById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      return probeJson((res.body as { data: { schedule: unknown } }).data.schedule);
    },
  },
  {
    n: 10, nome: 'VacanciesController.getVacancyById (GET admin)',
    probe: async (ctx) => {
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      return probeJson((res.body as { data: { schedule: unknown } }).data.schedule);
    },
  },
  {
    n: 11, nome: 'RecruitmentAnalyticsController.getCaseAnalysis',
    probe: async (ctx) => {
      const res = mockRes();
      await new RecruitmentAnalyticsController().getCaseAnalysis(asReq({ params: { caseNumber: String(ctx.caseNumber) } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const info = (res.body as { data: { caseInfo: { schedule: unknown } } }).data.caseInfo;
      return probeJson(info.schedule);
    },
  },
  {
    n: 12, nome: 'filtro por dia (vacancyScheduleFilter) via VacanciesController.listVacancies',
    probe: async (ctx) => {
      const listaPorDia = async (day: number) => {
        const res = mockRes();
        await new VacanciesController(diagnosisStub).listVacancies(asReq({ query: { days: String(day), limit: '50', offset: '0' } }), asRes(res));
        expect(res.statusCode).toBe(200);
        const ids = JSON.stringify(res.body);
        return ids.includes(ctx.vacancyId);
      };
      return { sawA: await listaPorDia(1), sawX: await listaPorDia(3) };
    },
  },
  {
    n: 13, nome: 'VacancyCrudController.updateVacancy (resposta do PUT, client cru + leitura efetiva)',
    seed: () => seed({ draft: true }),
    probe: async (ctx) => {
      const res = mockRes();
      const crud = new VacancyCrudController();
      await crud.updateVacancy(asReq({ params: { id: ctx.vacancyId }, body: { daily_obs: `obs ${randomUUID()}` }, user: { uid: UID } }), asRes(res));
      expect(res.statusCode).toBe(200);
      return probeJson((res.body as { data: { schedule: unknown } }).data.schedule);
    },
  },
];

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  identityPool = new Pool({ connectionString: ADMIN_URL, options: runtimeOptions(`-c app.user_country=AR -c app.user_uid=${UID}`), max: 4 });
  barePool = new Pool({ connectionString: ADMIN_URL, options: runtimeOptions(''), max: 4 });
  // Como o rlsAwarePool com a flag LIGADA: `query()` vai para o client fixado da request (COM identidade);
  // `connect()` entrega um client cru do pool (SEM GUCs). É a divergência que a restrição do leitor 13 cobre.
  const requestScoped = new Proxy(identityPool, {
    get(target, prop, receiver) {
      if (prop === 'connect') return (...a: unknown[]) => (barePool.connect as (...x: unknown[]) => unknown)(...a);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  jest.spyOn(DatabaseConnection, 'getInstance').mockReturnValue({
    getPool: () => requestScoped,
    getRawPool: () => requestScoped,
    getSystemPool: () => requestScoped,
    getClient: () => barePool.connect(),
  } as never);
  await wipe();
});

afterAll(async () => {
  await wipe();
  await Promise.all([admin.end(), identityPool.end(), barePool.end()]);
});

beforeEach(wipe);

describe('vacancyEffectiveFields.singleSource — o leitor lê o horário do SERVIÇO (app_runtime, banco real)', () => {
  it('são 13 leitores, na mesma ordem e nomes da lista F1', () => {
    expect(LEITORES_F1).toHaveLength(13);
    expect(LEITORES.map((l) => l.n)).toEqual(LEITORES_F1.map((s) => Number(s.split(' ')[0])));
    expect(LEITORES).toHaveLength(13);
  });

  it('a sessão do leitor é app_runtime (e a "crua" também), não a dona', async () => {
    const a = await identityPool.query(`SELECT current_user, current_setting('app.user_country', true) AS country`);
    const b = await barePool.query(`SELECT current_user, current_setting('app.user_country', true) AS country`);
    console.info(`[singleSource] sessão com identidade: ${JSON.stringify(a.rows[0])}; sessão crua: ${JSON.stringify(b.rows[0])}`);
    expect(a.rows[0]).toEqual({ current_user: 'app_runtime', country: 'AR' });
    expect(b.rows[0].current_user).toBe('app_runtime');
    expect(b.rows[0].country ?? '').toBe('');
  });

  describe.each(LEITORES.map((l) => [l.n, l] as const))('leitor %i', (_n, leitor) => {
    it(`${leitor.nome}: UPDATE no serviço (vaga intocada) -> a saída traz X`, async () => {
      const ctx = await (leitor.seed ?? seed)();
      if (leitor.n === 4) {
        await leitor.probe(ctx);
        return;
      }
      if (leitor.n === 7) await seedWorker([1]);
      const antes = await leitor.probe(ctx);
      expect(antes).toEqual({ sawA: true, sawX: false }); // controle positivo: o instrumento enxerga A
      await setServiceSchedule(ctx, SCHEDULE_X);
      const copia = await admin.query(`SELECT schedule FROM job_postings WHERE id = $1`, [ctx.vacancyId]);
      expect(copia.rows[0].schedule).toEqual(SCHEDULE_A); // a cópia da vaga continua A
      const depois = await leitor.probe(ctx);
      expect(depois).toEqual({ sawA: false, sawX: true });
    });
  });

  describe('casos adicionais', () => {
    it('vaga SEM serviço devolve o próprio horário da vaga', async () => {
      const ctx = await seed({ withService: false, vacancySchedule: SCHEDULE_X });
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      // o GET admin normaliza o horário para o formato por dia da semana; o conteúdo (14:15-18:45) é o da vaga
      expect(probeJson((res.body as { data: { schedule: unknown } }).data.schedule)).toEqual({ sawA: false, sawX: true });
    });

    it('serviço com horário NULL e vaga com cópia preenchida -> o leitor devolve vazio, NÃO a cópia', async () => {
      const ctx = await seed({ serviceSchedule: null, vacancySchedule: SCHEDULE_A });
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const schedule = (res.body as { data: { schedule: unknown } }).data.schedule;
      expect(mentions(schedule, '08:00')).toBe(false);
      expect(JSON.stringify(schedule ?? null)).toMatch(/^(null|\[\]|\{\})$/);
      const feed = await new JobPostingARRepository().findActivePublic({ country: 'AR' } as never);
      expect(feed.find((r) => r.id === ctx.vacancyId)?.schedule ?? null).toBeNull();
    });

    it('controle positivo de RLS: sessão que NÃO vê o paciente (outro país) não lê o serviço — o horário some, e o teste afirma isso', async () => {
      const ctx = await seed();
      const br = new Pool({ connectionString: ADMIN_URL, options: runtimeOptions('-c app.user_country=BR -c app.user_uid=vls-f1-br'), max: 2 });
      try {
        const visivelAR = await identityPool.query(`SELECT id FROM patient_contracted_services WHERE id = $1`, [ctx.serviceId]);
        const visivelBR = await br.query(`SELECT id FROM patient_contracted_services WHERE id = $1`, [ctx.serviceId]);
        const efetivoBR = await br.query(
          `SELECT CASE WHEN jp.contracted_service_id IS NOT NULL THEN e.schedule ELSE jp.schedule END AS schedule
             FROM job_postings jp LEFT JOIN patient_contracted_services e ON e.id = jp.contracted_service_id WHERE jp.id = $1`,
          [ctx.vacancyId],
        );
        console.info(`[singleSource] RLS: AR vê o serviço=${visivelAR.rowCount}; BR vê o serviço=${visivelBR.rowCount}; horário efetivo lido por BR=${JSON.stringify(efetivoBR.rows[0])}`);
        expect(visivelAR.rowCount).toBe(1);
        expect(visivelBR.rowCount).toBe(0);
        expect(efetivoBR.rows[0].schedule).toBeNull(); // NULL calado: o risco que a restrição do leitor 13 e a F8 vigiam
      } finally {
        await br.end();
      }
    });

    it('a lista explícita de colunas de job_postings == as colunas reais da tabela', async () => {
      const { rows } = await admin.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_postings' ORDER BY ordinal_position`,
      );
      expect(JOB_POSTING_COLUMNS).toEqual(rows.map((r) => r.column_name));
    });
  });

  describe('leitor 13 — client cru sem identidade (restrição do orquestrador)', () => {
    it('PUT e DELETE de vaga COM serviço não estouram rls_session_without_identity, e o PUT traz o horário do SERVIÇO', async () => {
      const ctx = await seed({ draft: true });
      await setServiceSchedule(ctx, SCHEDULE_X);
      const crud = new VacancyCrudController();

      const put = mockRes();
      await crud.updateVacancy(asReq({ params: { id: ctx.vacancyId }, body: { daily_obs: 'sem rls' }, user: { uid: UID } }), asRes(put));
      console.info(`[singleSource] PUT -> status ${put.statusCode} ${JSON.stringify(put.body).slice(0, 160)}`);
      expect(JSON.stringify(put.body)).not.toMatch(/rls_session_without_identity/);
      expect(put.statusCode).toBe(200);
      expect((put.body as { data: { schedule: unknown } }).data.schedule).toEqual(SCHEDULE_X);
      expect((await admin.query(`SELECT schedule FROM job_postings WHERE id = $1`, [ctx.vacancyId])).rows[0].schedule).toEqual(SCHEDULE_A);

      const del = mockRes();
      await crud.deleteVacancy(asReq({ params: { id: ctx.vacancyId }, user: { uid: UID } }), asRes(del));
      console.info(`[singleSource] DELETE -> status ${del.statusCode} ${JSON.stringify(del.body).slice(0, 160)}`);
      expect(JSON.stringify(del.body)).not.toMatch(/rls_session_without_identity/);
      expect(del.statusCode).toBe(200);
    });

    it('a sessão crua REPRODUZ o RAISE ao tocar o serviço (o controle positivo do instrumento)', async () => {
      const ctx = await seed({ draft: true });
      await expect(
        barePool.query(`SELECT e.schedule FROM job_postings jp LEFT JOIN patient_contracted_services e ON e.id = jp.contracted_service_id WHERE jp.id = $1`, [ctx.vacancyId]),
      ).rejects.toThrow(/rls_session_without_identity/);
      const soVaga = await barePool.query(`SELECT id FROM job_postings WHERE id = $1`, [ctx.vacancyId]);
      expect(soVaga.rowCount).toBe(1); // job_postings sozinho passa, como medido na stage
    });
  });
});
