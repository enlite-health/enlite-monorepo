/**
 * Fonte única do horário da vaga (change `vaga-le-do-servico-contratado`, F1) — banco REAL, sessão do leitor
 * como `app_runtime` (não a dona), com RLS ativa.
 *
 * Para CADA um dos 12 leitores de `job_postings.schedule` (lista F1 do `fatos-medidos.md`):
 *   paciente + serviço contratado (horário A) + vaga vinculada cuja CÓPIA `job_postings.schedule` é A;
 *   `UPDATE patient_contracted_services SET schedule = X` direto no SQL, SEM tocar a vaga;
 *   chama o leitor de produção (método/handler/função exportada, não cópia da query) e afirma que a saída traz X.
 *
 * Gemini/Talentum: nenhuma chamada de rede e nenhum módulo trocado — os dois leitores que terminam no Gemini são provados na
 * fronteira de DADOS (`loadVacancyDescriptionInput`, `loadVacancyForAiContent`: a linha lida, antes do LLM); a montagem do
 * prompt/payload a partir da linha é provada nos unitários (TalentumDescriptionService.test.ts, VacancyTalentumController.test.ts).
 * Roda no CI pelo `npm run test:e2e` (jest.config.e2e.js, `tests/e2e/**.test.ts`, backend-e2e.yml).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { JOB_POSTING_COLUMNS, VACANCY_EFFECTIVE_SERVICE_ALIAS as SVC, vacancyEffectiveAgeRangeSql, vacancyEffectiveJoinSql, vacancyEffectiveProvidersNeededSql, vacancyEffectiveRequiredSexSql } from '../../src/shared/sql/vacancyEffectiveFieldsSql';

import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { fetchPatientDetail } from '../../src/modules/case/infrastructure/PatientDetailQueryHelper';
import { loadVacancyDescriptionInput } from '../../src/modules/integration/infrastructure/TalentumDescriptionService';
import { loadVacancyForAiContent } from '../../src/modules/matching/interfaces/controllers/vacancyAiContentQuery';
import { FindNearbyVacanciesForWorkerUseCase } from '../../src/modules/matching/application/FindNearbyVacanciesForWorkerUseCase';
import { GetZoneAnalyticsUseCase } from '../../src/modules/matching/application/GetZoneAnalyticsUseCase';
import { MatchmakingService } from '../../src/modules/matching/infrastructure/MatchmakingService';
import { GetArmedCasesUseCase } from '../../src/modules/matching/application/GetArmedCasesUseCase';
import { horasAtivasQuery } from '../../src/modules/matching/application/managementDashboardQueries';
import { runHardFilter } from '../../src/modules/matching/infrastructure/MatchmakingHardFilterQuery';
import { JobPostingARRepository } from '../../src/modules/matching/infrastructure/JobPostingARRepository';
import { PublicVacancyController } from '../../src/modules/matching/interfaces/controllers/PublicVacancyController';
import { VacanciesController } from '../../src/modules/matching/interfaces/controllers/VacanciesController';
import { VacancyCrudController } from '../../src/modules/matching/interfaces/controllers/VacancyCrudController';
import { DataRealm } from '../../src/shared/domain/DataRealm';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const UID = 'vls-f1-staff-uid';
const TAG = 'vls-f1';

/** A = o que a cópia da vaga e o serviço têm no início. X = o que o serviço passa a ter (a vaga NÃO é tocada). */
// Spec 056: o horário do SERVIÇO são faixas (`patient_itinerary_slot`: início + duração); o fim é derivado.
const SCHEDULE_A = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }];
const SCHEDULE_X = [{ dayOfWeek: 3, startTime: '14:15', durationMinutes: 270 }];
/** O que o consumidor devolve para X (`horario_do_servico`): o mesmo turno + `endTime` derivado (14:15 + 270 min). */
const SCHEDULE_X_VIEW = [{ dayOfWeek: 3, startTime: '14:15', endTime: '18:45', durationMinutes: 270 }];
/** Vaga MANUAL (sem serviço) segue com o próprio `job_postings.schedule` legado (início/fim) — não é o horário do serviço. */
const VAGA_MANUAL_A = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
const VAGA_MANUAL_X = [{ dayOfWeek: 3, startTime: '14:15', endTime: '18:45' }];

/** A lista F1 do `fatos-medidos.md`, na ordem. O teste afirma que são 12 (eram 13; o 11 saiu) e que o corpo cobre cada um. */
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
  // 11 (RecruitmentAnalyticsController.getCaseAnalysis) saiu com o dashboard de recrutamento; a numeração dos demais foi mantida.
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

async function seed(opts: {
  draft?: boolean; status?: string; withService?: boolean; serviceSchedule?: unknown; vacancySchedule?: unknown;
  /** F5: quantidade no SERVIÇO (INT) e a cópia TEXT na vaga. Padrão 1 / '1' (comportamento da F1). */
  serviceProviders?: number | null; vacancyProviders?: string | null;
  /** F6: banda no SERVIÇO e a faixa (min,max) PRÓPRIA da vaga. Padrão: banda NULL e faixa NULL/NULL. */
  serviceBand?: string | null; vacancyAge?: [number | null, number | null];
} = {}): Promise<Ctx> {
  const { draft = false, status = 'SEARCHING', withService = true } = opts;
  // F7: a CHECK `job_postings_service_owns_fields_chk` proíbe vaga com serviço E valor próprio — a "cópia stale" que este
  // seed gravava de propósito (para provar que o leitor a ignora) não pode mais existir. `vacancy*` só vale para vaga
  // MANUAL; passá-lo com serviço é erro do teste (falha alto aqui, em vez de o banco recusar o INSERT adiante).
  if (withService && (opts.vacancySchedule !== undefined || opts.vacancyProviders !== undefined || opts.vacancyAge !== undefined)) {
    throw new Error('seed(): vacancySchedule/vacancyProviders/vacancyAge só valem para vaga MANUAL (withService:false); com serviço a vaga nasce com as 4 colunas NULL (F7)');
  }
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
      `INSERT INTO patient_contracted_services (id, patient_id, service_code, country, created_by, updated_by, providers_needed, address_id, provider_age_band)
       VALUES ($1, $2, 'AT', 'AR', $3, $3, $5, $4, $6)`,
      [serviceId, patientId, TAG, addressId,
        opts.serviceProviders === undefined ? 1 : opts.serviceProviders, opts.serviceBand ?? null],
    );
    // o horário do serviço = faixas vigentes (null = sem faixa = "sem horário")
    for (const t of (opts.serviceSchedule === null ? [] : ((opts.serviceSchedule as typeof SCHEDULE_A | undefined) ?? SCHEDULE_A))) {
      await admin.query(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '[2026-01-01,)', $5, $5)`,
        [serviceId, t.dayOfWeek, t.startTime, t.durationMinutes, TAG],
      );
    }
  }
  await admin.query(
    `INSERT INTO job_postings (id, title, case_number, patient_id, patient_address_id, contracted_service_id, schedule,
                               status, is_draft, required_professions, country, is_test, providers_needed, social_short_links,
                               age_range_min, age_range_max)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, ${withService ? `'{}'::text[]` : `ARRAY['AT']`}, 'AR', false, $10, '{"site":"https://enlite.test/x"}'::jsonb, $11, $12)`,
    [vacancyId, `CASO ${caseNumber}`, caseNumber, patientId, addressId, withService ? serviceId : null,
      withService ? null : JSON.stringify(opts.vacancySchedule === undefined ? VAGA_MANUAL_A : opts.vacancySchedule), status, draft,
      withService ? null : opts.vacancyProviders === undefined ? '1' : opts.vacancyProviders,
      withService ? null : opts.vacancyAge?.[0] ?? null, withService ? null : opts.vacancyAge?.[1] ?? null],
  );
  return { patientId, addressId, serviceId, vacancyId, caseNumber };
}

const setServiceProviders = (ctx: Ctx, n: number | null) =>
  admin.query(`UPDATE patient_contracted_services SET providers_needed = $2 WHERE id = $1`, [ctx.serviceId, n]);

const setServiceBand = (ctx: Ctx, band: string | null) =>
  admin.query(`UPDATE patient_contracted_services SET provider_age_band = $2 WHERE id = $1`, [ctx.serviceId, band]);

/** Troca o horário do serviço: fecha as faixas vigentes (até hoje) e abre as novas (a partir de hoje) — a mesma regra do escritor. */
const setServiceSchedule = async (ctx: Ctx, schedule: typeof SCHEDULE_X | null) => {
  await admin.query(
    `UPDATE patient_itinerary_slot SET valid = daterange(lower(valid), CURRENT_DATE, '[)')
      WHERE contracted_service_id = $1 AND upper_inf(valid)`,
    [ctx.serviceId],
  );
  for (const t of schedule ?? []) {
    await admin.query(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, $2, $3, $4, daterange(CURRENT_DATE, NULL, '[)'), $5, $5)`,
      [ctx.serviceId, t.dayOfWeek, t.startTime, t.durationMinutes, TAG],
    );
  }
};

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
    n: 2, nome: 'loadVacancyDescriptionInput (leitura da vaga que alimenta o prompt do Talentum; sem Gemini)',
    probe: async (ctx) => {
      const input = await loadVacancyDescriptionInput(identityPool, ctx.vacancyId);
      return { sawA: mentions(input.schedule, '08:00'), sawX: mentions(input.schedule, '14:15') && mentions(input.schedule, '18:45') };
    },
  },
  {
    n: 3, nome: 'loadVacancyForAiContent (leitura da vaga que alimenta o payload do parser; sem Gemini)',
    probe: async (ctx) => {
      const loaded = await loadVacancyForAiContent(identityPool, ctx.vacancyId);
      expect(loaded).not.toBeNull();
      const payload = loaded!.vacancyData.schedule;
      return { sawA: mentions(payload, '08:00'), sawX: mentions(payload, '14:15') && mentions(payload, '18:45') };
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


/**
 * F5 (`providers_needed`): a quantidade da vaga com serviço é lida do SERVIÇO (INT) e devolvida como TEXT (o tipo da
 * coluna da vaga), por todo leitor. Estado inicial: serviço = 2 e a coluna da vaga NULL (F7); o teste faz
 * `UPDATE patient_contracted_services SET providers_needed = 7` SEM tocar a vaga e afirma que o leitor passa a mostrar 7.
 */
interface LeitorQtd {
  nome: string;
  seed?: () => Promise<Ctx>;
  /** Devolve o que o leitor mostra como quantidade ('2' | '7' | outro), ou null se não mostra. */
  probe: (ctx: Ctx) => Promise<string | null>;
}

const LEITORES_QTD: LeitorQtd[] = [
  {
    nome: 'loadVacancyDescriptionInput (quantidade lida para o prompt do Talentum; sem Gemini)',
    probe: async (ctx) => {
      const v = (await loadVacancyDescriptionInput(identityPool, ctx.vacancyId)).providersNeeded;
      return v == null ? null : String(v);
    },
  },
  {
    nome: 'loadVacancyForAiContent (quantidade lida para o payload do parser; sem Gemini)',
    probe: async (ctx) => {
      const loaded = await loadVacancyForAiContent(identityPool, ctx.vacancyId);
      expect(loaded).not.toBeNull();
      const v = loaded!.vacancyData.providers_needed;
      return v == null ? null : String(v);
    },
  },
  {
    nome: 'GetArmedCasesUseCase.execute (serviço NULL = SEM_CONFIG; com valor = POR_ARMAR)',
    probe: async () => {
      const r = await new GetArmedCasesUseCase(identityPool).execute(['AR']);
      if (r.porArmar === 1 && r.semConfig === 0) return '2';
      if (r.porArmar === 0 && r.semConfig === 1) return '7';
      return `porArmar=${r.porArmar} semConfig=${r.semConfig}`;
    },
  },
  {
    nome: 'VacanciesController.listVacancies (faltantes = quantidade − preenchidas)',
    probe: async (ctx) => {
      const res = mockRes();
      await new VacanciesController(diagnosisStub).listVacancies(asReq({ query: { limit: '50', offset: '0' } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const rows = ((res.body as { data: unknown }).data ?? []) as Array<{ id: string; faltantes: unknown }>;
      const row = rows.find((r) => r.id === ctx.vacancyId);
      // a lista devolve `faltantes` com zeros à esquerda (ordenação lexicográfica: '02'); Number() tira o preenchimento
      return row ? String(Number(row.faltantes)) : null;
    },
  },
  {
    nome: 'VacanciesController.getVacancyById (GET admin)',
    probe: async (ctx) => {
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const v = (res.body as { data: { providers_needed: unknown } }).data.providers_needed;
      return v == null ? null : String(v);
    },
  },
  {
    nome: 'VacancyCrudController.updateVacancy (resposta do PUT, client cru + leitura efetiva)',
    seed: () => seed({ draft: true, serviceProviders: 2 }),
    probe: async (ctx) => {
      const res = mockRes();
      await new VacancyCrudController().updateVacancy(asReq({ params: { id: ctx.vacancyId }, body: { daily_obs: `obs ${randomUUID()}` }, user: { uid: UID } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const v = (res.body as { data: { providers_needed: unknown } }).data.providers_needed;
      return v == null ? null : String(v);
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
  it('são 12 leitores, na mesma ordem e nomes da lista F1', () => {
    expect(LEITORES_F1).toHaveLength(12);
    expect(LEITORES.map((l) => l.n)).toEqual(LEITORES_F1.map((s) => Number(s.split(' ')[0])));
    expect(LEITORES).toHaveLength(12);
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
      expect(copia.rows[0].schedule).toBeNull(); // a coluna da vaga segue NULL: quem manda é o serviço (F7: não há mais cópia)
      const depois = await leitor.probe(ctx);
      expect(depois).toEqual({ sawA: false, sawX: true });
    });
  });

  describe('casos adicionais', () => {
    it('vaga SEM serviço devolve o próprio horário da vaga', async () => {
      const ctx = await seed({ withService: false, vacancySchedule: VAGA_MANUAL_X });
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      // o GET admin normaliza o horário para o formato por dia da semana; o conteúdo (14:15-18:45) é o da vaga
      expect(probeJson((res.body as { data: { schedule: unknown } }).data.schedule)).toEqual({ sawA: false, sawX: true });
    });

    it('serviço com horário NULL (e a coluna da vaga NULL, como a F7 impõe) -> o leitor devolve vazio', async () => {
      // F7: a prova antiga ("a cópia stale preenchida é ignorada") não é mais montável — a CHECK impede a cópia.
      // Quem a substitui é a própria constraint (`vaga-sem-copia-do-servico.e2e.test.ts`: INSERT/UPDATE com valor próprio -> 23514).
      const ctx = await seed({ serviceSchedule: null });
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
          `SELECT CASE WHEN jp.contracted_service_id IS NOT NULL THEN horario_do_servico(jp.contracted_service_id, CURRENT_DATE) ELSE jp.schedule END AS schedule
             FROM job_postings jp WHERE jp.id = $1`,
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
      expect((put.body as { data: { schedule: unknown } }).data.schedule).toEqual(SCHEDULE_X_VIEW);
      expect((await admin.query(`SELECT schedule FROM job_postings WHERE id = $1`, [ctx.vacancyId])).rows[0].schedule).toBeNull(); // a coluna da vaga segue NULL (F7)

      const del = mockRes();
      await crud.deleteVacancy(asReq({ params: { id: ctx.vacancyId }, user: { uid: UID } }), asRes(del));
      console.info(`[singleSource] DELETE -> status ${del.statusCode} ${JSON.stringify(del.body).slice(0, 160)}`);
      expect(JSON.stringify(del.body)).not.toMatch(/rls_session_without_identity/);
      expect(del.statusCode).toBe(200);
    });

    it('a sessão crua REPRODUZ o RAISE ao tocar o serviço (o controle positivo do instrumento)', async () => {
      const ctx = await seed({ draft: true });
      await expect(
        barePool.query(`SELECT e.providers_needed FROM job_postings jp LEFT JOIN patient_contracted_services e ON e.id = jp.contracted_service_id WHERE jp.id = $1`, [ctx.vacancyId]),
      ).rejects.toThrow(/rls_session_without_identity/);
      const soVaga = await barePool.query(`SELECT id FROM job_postings WHERE id = $1`, [ctx.vacancyId]);
      expect(soVaga.rowCount).toBe(1); // job_postings sozinho passa, como medido na stage
    });
  });
});

describe('vacancyEffectiveFields.singleSource — F5: o leitor lê a QUANTIDADE do SERVIÇO (app_runtime, banco real)', () => {
  it('são 6 leitores de quantidade cobertos', () => {
    expect(LEITORES_QTD).toHaveLength(6);
  });

  describe.each(LEITORES_QTD.map((l) => [l.nome, l] as const))('%s', (_nome, leitor) => {
    it('UPDATE em pcs.providers_needed (vaga intocada) -> a saída passa de 2 para 7', async () => {
      const ctx = await (leitor.seed ?? (() => seed({ serviceProviders: 2 })))();
      const antes = await leitor.probe(ctx);
      expect(antes).toBe('2'); // controle positivo: o instrumento enxerga o valor inicial
      await setServiceProviders(ctx, leitor.nome.startsWith('GetArmedCasesUseCase') ? null : 7);
      const copia = await admin.query(`SELECT providers_needed FROM job_postings WHERE id = $1`, [ctx.vacancyId]);
      expect(copia.rows[0].providers_needed).toBeNull(); // a coluna da vaga segue NULL (F7: não há mais cópia)
      expect(await leitor.probe(ctx)).toBe('7');
    });
  });

  describe('casos adicionais', () => {
    it('vaga MANUAL (sem serviço) devolve o próprio valor da vaga', async () => {
      const ctx = await seed({ withService: false, vacancyProviders: '5' });
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect((res.body as { data: { providers_needed: unknown } }).data.providers_needed).toBe('5');
    });

    it('vaga COM serviço e cópia NULL (estado pós-F5) devolve a quantidade do serviço, como TEXT', async () => {
      const ctx = await seed({ serviceProviders: 4 });
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect((res.body as { data: { providers_needed: unknown } }).data.providers_needed).toBe('4');
    });

    it('serviço com quantidade NULL (e a coluna da vaga NULL, como a F7 impõe) -> o leitor devolve NULL', async () => {
      // F7: a cópia stale '9' não é mais montável (CHECK); a prova "nunca COALESCE" passa a ser a própria constraint.
      const ctx = await seed({ serviceProviders: null });
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect((res.body as { data: { providers_needed: unknown } }).data.providers_needed ?? null).toBeNull();
    });

    it('tipos: a expressão efetiva é TEXT nos dois ramos, e comparar vaga × serviço pela peça NÃO dá `text = integer`', async () => {
      const comServico = await seed({ serviceProviders: 3 });
      const manual = await seed({ withService: false, vacancyProviders: '5' });
      const expr = vacancyEffectiveProvidersNeededSql('jp');
      const tipos = await identityPool.query<{ id: string; tipo: string; valor: string | null }>(
        `SELECT jp.id, pg_typeof(${expr})::text AS tipo, ${expr} AS valor
           FROM job_postings jp ${vacancyEffectiveJoinSql('jp')} WHERE jp.id = ANY($1::uuid[])`,
        [[comServico.vacancyId, manual.vacancyId]],
      );
      const byId = new Map(tipos.rows.map((r) => [r.id, r]));
      expect(byId.get(comServico.vacancyId)).toMatchObject({ tipo: 'text', valor: '3' });
      expect(byId.get(manual.vacancyId)).toMatchObject({ tipo: 'text', valor: '5' });
      // comparação vaga × serviço: o efetivo (TEXT) contra o INT do serviço com cast explícito do lado do serviço
      const cmp = await identityPool.query<{ igual: boolean }>(
        `SELECT (${expr}) = ${SVC}.providers_needed::text AS igual
           FROM job_postings jp ${vacancyEffectiveJoinSql('jp')} WHERE jp.id = $1`,
        [comServico.vacancyId],
      );
      expect(cmp.rows[0].igual).toBe(true);
      // o erro de produção (text = integer) acontece SEM a peça: comparar a coluna crua com o INT do serviço
      await expect(
        identityPool.query(`SELECT jp.providers_needed = ${SVC}.providers_needed FROM job_postings jp ${vacancyEffectiveJoinSql('jp')} WHERE jp.id = $1`, [comServico.vacancyId]),
      ).rejects.toThrow(/operator does not exist: text = integer/);
    });
  });
});

/**
 * F6 (faixa etária): a faixa da vaga com serviço é DERIVADA de `patient_contracted_services.provider_age_band` (mapeamento
 * em TS, `ProviderAgeBandMapping.ts`). Estado inicial: banda AGE_20_30 (20-29) e as colunas da vaga NULL (F7). O teste faz
 * `UPDATE ... SET provider_age_band = 'AGE_30_45'` SEM tocar a vaga e afirma que o leitor passa a mostrar 30-44.
 */
interface LeitorFaixa {
  nome: string;
  seed?: () => Promise<Ctx>;
  /** Devolve a faixa que o leitor mostra, como 'min-max' ('' = ausente), ou null se não achou a vaga. */
  probe: (ctx: Ctx) => Promise<string | null>;
}

const faixa = (min: unknown, max: unknown): string => `${min ?? ''}-${max ?? ''}`;
const seedFaixa = (extra: Parameters<typeof seed>[0] = {}) => seed({ serviceBand: 'AGE_20_30', ...extra });

const LEITORES_FAIXA: LeitorFaixa[] = [
  {
    nome: 'JobPostingARRepository.findActivePublic (feed público)',
    probe: async (ctx) => {
      const rows = await new JobPostingARRepository().findActivePublic({ country: 'AR' } as never);
      const row = rows.find((r) => r.id === ctx.vacancyId);
      return row ? faixa(row.age_range_min, row.age_range_max) : null;
    },
  },
  {
    nome: 'PublicVacancyController.getById (detalhe público)',
    probe: async (ctx) => {
      const res = mockRes();
      await new PublicVacancyController(diagnosisStub).getById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const d = (res.body as { data: Record<string, unknown> }).data;
      expect(d).not.toHaveProperty('effective_provider_age_band');
      return faixa(d.age_range_min, d.age_range_max);
    },
  },
  {
    nome: 'VacanciesController.getVacancyById (detalhe admin)',
    probe: async (ctx) => {
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const d = (res.body as { data: Record<string, unknown> }).data;
      expect(d).not.toHaveProperty('effective_provider_age_band');
      return faixa(d.age_range_min, d.age_range_max);
    },
  },
  {
    nome: 'loadVacancyDescriptionInput (faixa etária lida para o prompt do Talentum; sem Gemini)',
    probe: async (ctx) => {
      const i = await loadVacancyDescriptionInput(identityPool, ctx.vacancyId);
      return faixa(i.ageRangeMin, i.ageRangeMax);
    },
  },
  {
    nome: 'loadVacancyForAiContent (faixa etária lida para o payload do parser; sem Gemini)',
    probe: async (ctx) => {
      const loaded = await loadVacancyForAiContent(identityPool, ctx.vacancyId);
      expect(loaded).not.toBeNull();
      return faixa(loaded!.vacancyData.age_range_min, loaded!.vacancyData.age_range_max);
    },
  },
  {
    nome: 'VacancyCrudController.updateVacancy (resposta do PUT, client cru + leitura efetiva)',
    seed: () => seedFaixa({ draft: true }),
    probe: async (ctx) => {
      const res = mockRes();
      await new VacancyCrudController().updateVacancy(asReq({ params: { id: ctx.vacancyId }, body: { daily_obs: `obs ${randomUUID()}` }, user: { uid: UID } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const d = (res.body as { data: Record<string, unknown> }).data;
      expect(d).not.toHaveProperty('effective_provider_age_band');
      return faixa(d.age_range_min, d.age_range_max);
    },
  },
];

describe('vacancyEffectiveFields.singleSource — F6: o leitor deriva a FAIXA ETÁRIA da banda do SERVIÇO (app_runtime, banco real)', () => {
  it('são 6 leitores da faixa cobertos', () => {
    expect(LEITORES_FAIXA).toHaveLength(6);
  });

  describe.each(LEITORES_FAIXA.map((l) => [l.nome, l] as const))('%s', (_nome, leitor) => {
    it('UPDATE em pcs.provider_age_band (vaga intocada) -> a saída passa de 20-29 para 30-44', async () => {
      const ctx = await (leitor.seed ?? (() => seedFaixa()))();
      expect(await leitor.probe(ctx)).toBe('20-29'); // controle positivo: o instrumento enxerga a faixa inicial
      await setServiceBand(ctx, 'AGE_30_45');
      const copia = await admin.query(`SELECT age_range_min, age_range_max FROM job_postings WHERE id = $1`, [ctx.vacancyId]);
      expect(copia.rows[0]).toEqual({ age_range_min: null, age_range_max: null }); // as colunas da vaga seguem NULL (F7: não há mais cópia)
      expect(await leitor.probe(ctx)).toBe('30-44');
    });

    it('serviço com banda NULL (e as colunas da vaga NULL, como a F7 impõe) -> faixa VAZIA', async () => {
      // F7: a cópia antiga 20-29 não é mais montável (CHECK); a prova "nunca COALESCE" passa a ser a própria constraint.
      const ctx = await (leitor.seed ?? (() => seedFaixa()))();
      await setServiceBand(ctx, null);
      const out = await leitor.probe(ctx);
      expect(out === '-' || out === '').toBe(true);
    });
  });

  describe('casos adicionais', () => {
    it('banda AGE_45_PLUS -> 45 sem teto; ANY -> faixa vazia', async () => {
      const ctx = await seedFaixa();
      const feed = async () => {
        const rows = await new JobPostingARRepository().findActivePublic({ country: 'AR' } as never);
        const row = rows.find((x) => x.id === ctx.vacancyId)!;
        return faixa(row.age_range_min, row.age_range_max);
      };
      await setServiceBand(ctx, 'AGE_45_PLUS');
      expect(await feed()).toBe('45-');
      await setServiceBand(ctx, 'ANY');
      expect(await feed()).toBe('-');
    });

    it('vaga MANUAL (sem serviço) devolve a PRÓPRIA faixa da vaga', async () => {
      const ctx = await seed({ withService: false, vacancyAge: [25, 40] });
      const res = mockRes();
      await new PublicVacancyController(diagnosisStub).getById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      const d = (res.body as { data: Record<string, unknown> }).data;
      expect(faixa(d.age_range_min, d.age_range_max)).toBe('25-40');
      const rows = await new JobPostingARRepository().findActivePublic({ country: 'AR' } as never);
      const row = rows.find((x) => x.id === ctx.vacancyId)!;
      expect(faixa(row.age_range_min, row.age_range_max)).toBe('25-40');
    });

    it('a peça devolve NULL/NULL e a banda crua para a vaga com serviço (a derivação é só em TS)', async () => {
      const ctx = await seedFaixa();
      const { rows } = await identityPool.query(
        `SELECT ${vacancyEffectiveAgeRangeSql('jp')} FROM job_postings jp ${vacancyEffectiveJoinSql('jp')} WHERE jp.id = $1`,
        [ctx.vacancyId],
      );
      expect(rows[0]).toEqual({ age_range_min: null, age_range_max: null, effective_provider_age_band: 'AGE_20_30' });
    });
  });
});

/**
 * 057 (D523): os 5 campos de RECRUTAMENTO (`required_sex`, `required_professions`, `required_experience`, `work_schedule`,
 * `payment_day`) da vaga com serviço são lidos de `patient_contracted_services`; a vaga os guarda NULL. Mesmo molde dos grupos
 * acima: serviço semeado com A, vaga com os 5 NULL, controle positivo (o leitor devolve A), `UPDATE` direto no serviço SEM tocar
 * a vaga, o leitor devolve X e o SELECT direto da vaga segue NULL. Vaga MANUAL (sem serviço) segue dona dos próprios valores.
 */
type Campo = 'sex' | 'profs' | 'exp' | 'ws' | 'pay';
type Obs = Partial<Record<Campo, string | string[] | null>>;
const REC_A = { sex: 'F', profs: ['AT'], exp: 'EXP-A', ws: 'part-time', pay: 'DIA-A' } as const;
// X usa CAREGIVER (não NURSE): é um dos dois valores que o filtro `worker_type` da lista admin aceita (VALID_WORKER_TYPES).
const REC_X = { sex: 'M', profs: ['CAREGIVER'], exp: 'EXP-X', ws: 'full-time', pay: 'DIA-X' } as const;
const ZONA_057 = 'Zona 057';
const pick = (src: Record<string, unknown>, campos: readonly Campo[]): Obs => Object.fromEntries(campos.map((c) => [c, src[c]]));

const setServiceRecruitment = (ctx: Ctx, v: typeof REC_A | typeof REC_X) =>
  admin.query(
    `UPDATE patient_contracted_services SET required_sex = $2, required_professions = $3::text[], required_experience = $4,
            work_schedule = $5, payment_day = $6 WHERE id = $1`,
    [ctx.serviceId, v.sex, v.profs, v.exp, v.ws, v.pay],
  );

/** Vaga COM serviço: serviço com A e os 5 da vaga NULL (D523). Endereço numa zona própria, para o leitor de zona achar só esta vaga. */
async function seedRec(opts: { draft?: boolean } = {}): Promise<Ctx> {
  const ctx = await seed({ draft: opts.draft });
  await setServiceRecruitment(ctx, REC_A);
  await admin.query(
    `UPDATE job_postings SET required_sex = NULL, required_professions = NULL, required_experience = NULL, work_schedule = NULL, payment_day = NULL WHERE id = $1`,
    [ctx.vacancyId],
  );
  await admin.query(`UPDATE patient_addresses SET state = $2, city = $2 WHERE id = $1`, [ctx.addressId, ZONA_057]);
  return ctx;
}

/** Vaga MANUAL (sem serviço): os 5 são da PRÓPRIA vaga. */
async function seedRecManual(opts: { draft?: boolean } = {}): Promise<Ctx> {
  const ctx = await seed({ withService: false, draft: opts.draft });
  await admin.query(
    `UPDATE job_postings SET required_sex = $2, required_professions = $3::text[], required_experience = $4, work_schedule = $5, payment_day = $6 WHERE id = $1`,
    [ctx.vacancyId, REC_A.sex, REC_A.profs, REC_A.exp, REC_A.ws, REC_A.pay],
  );
  await admin.query(`UPDATE patient_addresses SET state = $2, city = $2 WHERE id = $1`, [ctx.addressId, ZONA_057]);
  return ctx;
}

interface LeitorRec {
  nome: string;
  campos: readonly Campo[];
  draft?: boolean;
  probe: (ctx: Ctx) => Promise<Obs>;
}

/** Lista admin / feed filtrado: em vez de ler o campo, descobre qual valor o FILTRO casa com a vaga. */
const matchedBy = async <T,>(values: readonly T[], hit: (v: T) => Promise<boolean>): Promise<T[]> => {
  const out: T[] = [];
  for (const v of values) if (await hit(v)) out.push(v);
  return out;
};
const adminListHits = async (ctx: Ctx, query: Record<string, string>): Promise<boolean> => {
  const res = mockRes();
  await new VacanciesController(diagnosisStub).listVacancies(asReq({ query: { limit: '50', offset: '0', ...query } }), asRes(res));
  expect(res.statusCode).toBe(200);
  return JSON.stringify(res.body).includes(ctx.vacancyId);
};
const publicFeedHits = async (ctx: Ctx, filters: Record<string, string>): Promise<boolean> => {
  const rows = await new JobPostingARRepository().findActivePublic({ country: 'AR', ...filters } as never);
  return rows.some((r) => r.id === ctx.vacancyId);
};
const zoneDemand = async (profession: string): Promise<number> => {
  const blind = { generateValueBidx: async () => Buffer.from('x') } as never;
  const out = await new GetZoneAnalyticsUseCase(identityPool, blind).execute({ profession });
  return out.zones.filter((z) => z.zone.includes(ZONA_057)).reduce((n, z) => n + z.demand, 0);
};

const LEITORES_REC: LeitorRec[] = [
  {
    nome: 'MatchmakingService.loadJob (carrega a vaga do matching: sexo e profissões)',
    campos: ['sex', 'profs'],
    probe: async (ctx) => {
      const job = await (new MatchmakingService() as unknown as { loadJob(id: string): Promise<{ requiredSex: string | null; requiredProfessions: string[] | null }> }).loadJob(ctx.vacancyId);
      return { sex: job.requiredSex, profs: job.requiredProfessions };
    },
  },
  {
    nome: 'JobPostingARRepository.findActivePublic (feed público: worker_sex / worker_type)',
    campos: ['sex', 'profs'],
    probe: async (ctx) => {
      const row = (await new JobPostingARRepository().findActivePublic({ country: 'AR' } as never)).find((r) => r.id === ctx.vacancyId)!;
      return { sex: row.worker_sex as string | null, profs: row.worker_type as unknown as string[] };
    },
  },
  {
    nome: 'PublicJobsQueryBuilder via findActivePublic (filtros worker_sex e worker_type do feed)',
    campos: ['sex', 'profs'],
    probe: async (ctx) => ({
      sex: (await matchedBy(['F', 'M'], (v) => publicFeedHits(ctx, { worker_sex: v })))[0] ?? null,
      profs: await matchedBy(['AT', 'CAREGIVER'], (v) => publicFeedHits(ctx, { worker_type: v })),
    }),
  },
  {
    nome: 'PublicVacancyController.getById (detalhe público)',
    campos: ['sex', 'profs'],
    probe: async (ctx) => {
      const res = mockRes();
      await new PublicVacancyController(diagnosisStub).getById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const d = (res.body as { data: Record<string, unknown> }).data;
      return { sex: d.required_sex as string | null, profs: d.required_professions as string[] };
    },
  },
  {
    nome: 'VacanciesController.getVacancyById (GET admin, os 5)',
    campos: ['sex', 'profs', 'exp', 'ws', 'pay'],
    probe: async (ctx) => {
      const res = mockRes();
      await new VacanciesController(diagnosisStub).getVacancyById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      expect(res.statusCode).toBe(200);
      const d = (res.body as { data: Record<string, unknown> }).data;
      return { sex: d.required_sex as string, profs: d.required_professions as string[], exp: d.required_experience as string, ws: d.work_schedule as string, pay: d.payment_day as string };
    },
  },
  {
    nome: 'vacancyListHelpers via VacanciesController.listVacancies (filtros required_sex e worker_type)',
    campos: ['sex', 'profs'],
    probe: async (ctx) => ({
      sex: (await matchedBy(['F', 'M'], (v) => adminListHits(ctx, { required_sex: v })))[0] ?? null,
      profs: await matchedBy(['AT', 'CAREGIVER'], (v) => adminListHits(ctx, { worker_type: v })),
    }),
  },
  {
    nome: 'loadVacancyForAiContent (payload do parser de IA, os 5; sem Gemini)',
    campos: ['sex', 'profs', 'exp', 'ws', 'pay'],
    probe: async (ctx) => {
      const loaded = await loadVacancyForAiContent(identityPool, ctx.vacancyId);
      expect(loaded).not.toBeNull();
      const v = loaded!.vacancyData;
      return { sex: v.required_sex, profs: v.required_professions, exp: v.required_experience, ws: v.work_schedule, pay: v.payment_day };
    },
  },
  {
    nome: 'loadVacancyDescriptionInput (prompt do Talentum, os 5; sem Gemini)',
    campos: ['sex', 'profs', 'exp', 'ws', 'pay'],
    probe: async (ctx) => {
      const i = await loadVacancyDescriptionInput(identityPool, ctx.vacancyId);
      return { sex: i.requiredSex ?? null, profs: i.requiredProfessions, exp: i.requiredExperience ?? null, ws: i.workSchedule ?? null, pay: i.paymentDay ?? null };
    },
  },
  {
    nome: 'GetZoneAnalyticsUseCase.execute (filtro de profissão na demanda por zona)',
    campos: ['profs'],
    probe: async () => ({ profs: await matchedBy(['AT', 'CAREGIVER'], async (p) => (await zoneDemand(p)) > 0) }),
  },
  // VacancyCrudController.updateVacancy NÃO entra: `withEffectiveFields` só troca schedule/providers_needed/faixa, então a RESPOSTA do PUT
  // de vaga com serviço devolve os 5 de recrutamento crus (NULL). Achado da F5 registrado para o orquestrador; sem teste que cristalize o defeito.
];

describe('vacancyEffectiveFields.singleSource — 057: o leitor lê os 5 campos de RECRUTAMENTO do SERVIÇO (app_runtime, banco real)', () => {
  it('são 9 leitores cobertos; FindNearbyVacanciesForWorkerUseCase tem o caso próprio abaixo', () => {
    expect(LEITORES_REC).toHaveLength(9);
  });

  describe.each(LEITORES_REC.map((l) => [l.nome, l] as const))('%s', (_nome, leitor) => {
    it('UPDATE no serviço (vaga intocada) -> a saída passa de A para X, e a coluna da vaga segue NULL', async () => {
      const ctx = await seedRec({ draft: leitor.draft });
      expect(await leitor.probe(ctx)).toEqual(pick(REC_A, leitor.campos)); // controle positivo: o instrumento enxerga A
      await setServiceRecruitment(ctx, REC_X);
      const vaga = await admin.query(
        `SELECT required_sex, required_professions, required_experience, work_schedule, payment_day FROM job_postings WHERE id = $1`,
        [ctx.vacancyId],
      );
      expect(vaga.rows[0]).toEqual({ required_sex: null, required_professions: null, required_experience: null, work_schedule: null, payment_day: null });
      expect(await leitor.probe(ctx)).toEqual(pick(REC_X, leitor.campos));
    });

    it('vaga MANUAL (sem serviço) segue dona dos próprios valores', async () => {
      const ctx = await seedRecManual({ draft: leitor.draft });
      expect(await leitor.probe(ctx)).toEqual(pick(REC_A, leitor.campos));
    });
  });

  describe('casos adicionais', () => {
    it('FindNearbyVacanciesForWorkerUseCase (profissão efetiva) segue QUEBRADO pelo defeito anterior (jp.patient_zone); sem observação possível', async () => {
      // O mesmo defeito do leitor 4 do grupo F1: a query seleciona `jp.patient_zone`, coluna dropada na migration 039. A troca da
      // profissão pela peça (`w.occupation = ANY(efetiva)`) está no código, mas não é exercível até alguém consertar o leitor.
      await seedRec();
      const workerId = await seedWorker([1]);
      await expect(new FindNearbyVacanciesForWorkerUseCase(identityPool).execute(workerId, 1, 30, 5)).rejects.toThrow(/column jp\.patient_zone does not exist/);
    });

    it('serviço com sexo NULL e profissões NULL -> o leitor devolve NULL e [] (a peça não inventa valor)', async () => {
      const ctx = await seedRec();
      await admin.query(`UPDATE patient_contracted_services SET required_sex = NULL, required_professions = NULL WHERE id = $1`, [ctx.serviceId]);
      const res = mockRes();
      await new PublicVacancyController(diagnosisStub).getById(asReq({ params: { id: ctx.vacancyId } }), asRes(res));
      const d = (res.body as { data: Record<string, unknown> }).data;
      expect(d.required_sex ?? null).toBeNull();
      expect(d.required_professions).toEqual([]);
    });

    it('controle positivo de RLS: sessão de OUTRO país (BR) não lê o serviço — o sexo efetivo some, e o teste afirma isso', async () => {
      const ctx = await seedRec();
      const br = new Pool({ connectionString: ADMIN_URL, options: runtimeOptions('-c app.user_country=BR -c app.user_uid=vls-057-br'), max: 2 });
      try {
        const efetivo = (pool: Pool) => pool.query(
          `SELECT ${vacancyEffectiveRequiredSexSql('jp')} AS sex FROM job_postings jp ${vacancyEffectiveJoinSql('jp')} WHERE jp.id = $1`,
          [ctx.vacancyId],
        );
        expect((await efetivo(identityPool)).rows[0].sex).toBe('F'); // AR vê o serviço
        expect((await efetivo(br)).rows[0].sex).toBeNull(); // BR não vê: NULL calado
      } finally {
        await br.end();
      }
    });
  });
});
