/**
 * enquadre-076-lista.e2e.test.ts — spec 076: a lista GLOBAL de enquadres (`GET /api/admin/enquadre-events`) contra POSTGRES REAL,
 * HTTP real, com o ENGINE DE PERMISSÃO LIGADO (família `admin.vacancies`).
 *
 * Nada de dublê: o caso de uso, o repositório e o SQL são os de produção. Dados SINTÉTICOS ("Ficticio NN", `@example.test`).
 * O PROCESSO inteiro roda com `TimeZone = Asia/Tokyo` na sessão do Postgres (PGOPTIONS, antes de qualquer pool): Tóquio (+09)
 * difere de Buenos Aires (-03) e de UTC, então nenhuma conversão que dependa do fuso da sessão passa por coincidência.
 * As janelas dos casos ficam em anos distintos/futuros (2031) para não colidir com eventos de outras suítes.
 *
 * O que cada caso mata (sabotagem → vermelho):
 *   1 tirar o 2º `perm.require` (vacancy:read) ou o 1º (enquadre_event:read)
 *   2 semana em UTC (`date_trunc('week', now())`) em vez de `CURRENT_WEEK_START_SQL`
 *   3 filtro por `$from::timestamptz` (fuso da sessão) em vez de hora de parede em Buenos Aires
 *   4 `sum` só da página (total/convokedTotal do conjunto filtrado inteiro) · contar `removed`
 *   5 tirar o predicado `country = ANY($1)` do SQL
 *   6 limite de 92 dias errado · aceitar `to < from`
 *   7 devolver nome/e-mail do paciente, do convocado ou do entrevistador
 */
const PGOPTIONS_ANTERIOR = process.env.PGOPTIONS;
process.env.PGOPTIONS = '-c TimeZone=Asia/Tokyo';

import { Pool } from 'pg';
import { DateTime } from 'luxon';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { CURRENT_WEEK_START_SQL, OPERATION_TIMEZONE } from '../../src/modules/matching/domain/interviewSchedule';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PATIENT_FIRST = 'Ficticia';
const PATIENT_LAST = `Sobrenomeunico${RUN}`;
const WORKER_NAME_MARK = `Ficticio076${RUN}`;
const HOST_EMAIL = `host.e2e076.${RUN}@example.test`;
const HOST_NAME = `Entrevistadora Sintetica ${RUN}`;
const HOST_NAME_2 = `Entrevistadora Sintetica Dos ${RUN}`;
const CASE_AR = 910000 + Math.floor(Math.random() * 80000);
const CASE_BR = CASE_AR + 1;
const TITLE = `ENQ076 e2e ${RUN}`;

const UID_FULL = 'enq076-full';
const UID_SO_EVENTO = 'enq076-so-evento';
const UID_SO_VAGA = 'enq076-so-vaga';
const GRUPO_FULL = `Enq076 Full ${RUN}`;
const GRUPO_SO_EVENTO = `Enq076 SoEvento ${RUN}`;
const GRUPO_SO_VAGA = `Enq076 SoVaga ${RUN}`;
const UIDS = [UID_FULL, UID_SO_EVENTO, UID_SO_VAGA];
const GRUPOS = [GRUPO_FULL, GRUPO_SO_EVENTO, GRUPO_SO_VAGA];

/** Hora de parede de Buenos Aires → ISO com offset (o `starts_at` entra sem depender do fuso da sessão). */
const ba = (ymd: string, hhmm: string): string =>
  DateTime.fromISO(`${ymd}T${hhmm}`, { zone: OPERATION_TIMEZONE }).toISO() as string;

describe('lista global de enquadres — HTTP real, banco real, engine LIGADO (spec 076)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let vacAR: string;
  let vacBR: string;
  const patients: string[] = [];
  const workers: string[] = [];
  let codeSeq = Math.floor(Math.random() * 20_000_000) + 1_000_000;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  async function get(query: string, uid = UID_FULL) {
    const res = await fetch(`${app.url}/api/admin/enquadre-events${query}`, {
      headers: { Authorization: tokenMock(uid, 'admin', 'AR') },
    });
    const text = await res.text();
    return { status: res.status, text, body: (JSON.parse(text || '{}') ?? {}) as Record<string, any> };
  }

  const nextCode = (): string => {
    codeSeq += 1;
    return `ENC-${codeSeq.toString(36).toUpperCase().padStart(6, '0').slice(-6)}`;
  };

  /** Evento por SQL (a lista só lê). `startsAt` = ISO com offset ou expressão SQL (`sql: true`). */
  async function evento(opts: {
    vac: string;
    country?: 'AR' | 'BR';
    startsAt: string;
    sql?: boolean;
    status?: 'open' | 'closed' | 'cancelled';
    host?: string;
    importStatus?: string;
    blockedReason?: string;
  }): Promise<string> {
    const status = opts.status ?? 'open';
    const start = opts.sql ? `COALESCE($7::timestamptz, ${opts.startsAt})` : '$7::timestamptz';
    const { rows } = await admin.query(
      `INSERT INTO enquadre_events
         (job_posting_id, country, host_email, host_display_name, starts_at, ends_at, event_code, status, created_by_uid,
          closed_at, closed_by_uid, cancelled_at, cancelled_by_uid, import_status, blocked_reason)
       SELECT $1::uuid, $2::text, $3::text, $4::text, ${start}, ${start} + interval '1 hour', $5::text, $6::text, $8::text,
              CASE WHEN $6::text = 'closed' THEN now() END, CASE WHEN $6::text = 'closed' THEN $8::text END,
              CASE WHEN $6::text = 'cancelled' THEN now() END, CASE WHEN $6::text = 'cancelled' THEN $8::text END,
              $9::text, $10::text
       RETURNING id`,
      [
        opts.vac,
        opts.country ?? 'AR',
        HOST_EMAIL,
        opts.host ?? HOST_NAME,
        nextCode(),
        status,
        opts.sql ? null : opts.startsAt,
        UID_FULL,
        opts.importStatus ?? null,
        opts.blockedReason ?? null,
      ],
    );
    return rows[0].id as string;
  }

  async function novoWorker(): Promise<string> {
    const n = workers.length + 1;
    const { rows } = await admin.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status, first_name_encrypted, last_name_encrypted)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', $3, $3) RETURNING id`,
      [`enq076-${RUN}-${n}`, `worker${n}.e2e076.${RUN}@example.test`, WORKER_NAME_MARK],
    );
    workers.push(rows[0].id as string);
    return rows[0].id as string;
  }

  /** Participação por SQL: `kind` = null é ATIVA; `closed` leva carimbo de resultado; `removed` não conta como convocado. */
  async function participante(eventId: string, vac: string, workerId: string, kind: 'closed' | 'cancelled' | 'removed' | null) {
    await admin.query(
      `INSERT INTO enquadre_event_participants (event_id, job_posting_id, worker_id, added_by_uid, released_at, release_kind, outcome)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $5::text,
               CASE WHEN $5::text = 'closed' THEN 'selected' END)`,
      [eventId, vac, workerId, UID_FULL, kind],
    );
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await admin.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`, [GRUPOS]);
    await limparIamFixtures(admin, { uids: UIDS, grupos: GRUPOS });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.vacancies');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    for (const [uid, mail] of [[UID_FULL, 'full'], [UID_SO_EVENTO, 'so-evento'], [UID_SO_VAGA, 'so-vaga']]) {
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, $2, 'admin', 'ACTIVE', true, $3)`,
        [uid, `enq076-${mail}@e2e.local`, TENANT_E2E],
      );
    }
    const grupos: Array<[string, string, Array<[string, string]>]> = [
      [GRUPO_FULL, UID_FULL, [['enquadre_event', 'read'], ['vacancy', 'read']]],
      [GRUPO_SO_EVENTO, UID_SO_EVENTO, [['enquadre_event', 'read']]],
      [GRUPO_SO_VAGA, UID_SO_VAGA, [['vacancy', 'read']]],
    ];
    for (const [nome, uid, celulas] of grupos) {
      const groupId = await grupoComCelulas(admin, { nome, uid, celulas });
      // `grupoComCelulas` NÃO grava o escopo de país: sem ele toda chamada seria COUNTRY_SCOPE_REQUIRED. Os três atores são SÓ-AR.
      await admin.query(
        `INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', $2, 'e2e 076')`,
        [groupId, uid],
      );
    }

    for (const [country, n] of [['AR', CASE_AR], ['BR', CASE_BR]] as const) {
      const pat = await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [`e2e-076-${country}-${RUN}`, PATIENT_FIRST, PATIENT_LAST, country],
      );
      patients.push(pat.rows[0].id);
      const vac = await admin.query(
        `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number)
         VALUES ($1, $2, 'SEARCHING', false, $3, true, $4) RETURNING id`,
        [`${TITLE} ${country}`, pat.rows[0].id, country, n],
      );
      if (country === 'AR') vacAR = vac.rows[0].id;
      else vacBR = vac.rows[0].id;
    }

    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { EnquadreEventGlobalList } = await import('../../src/modules/matching/application/EnquadreEventGlobalList');
    const { EnquadreEventListController } = await import('../../src/modules/matching/interfaces/controllers/EnquadreEventListController');
    const { createAdminEnquadreEventListRoutes } = await import('../../src/modules/matching/interfaces/routes/adminEnquadreEventListRoutes');
    const pool = DatabaseConnection.getInstance().getPool();
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.vacancies',
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use(
          '/api/admin',
          createAdminEnquadreEventListRoutes(auth, permissions, new EnquadreEventListController(pool, new EnquadreEventGlobalList({ db: pool }))),
        );
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    // Só o que ESTE teste criou, por id. A vaga leva eventos e participações por CASCADE.
    const vagas = [vacAR, vacBR].filter(Boolean);
    if (vagas.length) await admin.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [vagas]);
    if (workers.length) await admin.query(`DELETE FROM workers WHERE id = ANY($1)`, [workers]);
    if (patients.length) await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    await admin.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`, [GRUPOS]);
    await limparIamFixtures(admin, { uids: UIDS, grupos: GRUPOS });
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (PGOPTIONS_ANTERIOR === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = PGOPTIONS_ANTERIOR;
  });

  it('0. controle: a sessão do app roda em Asia/Tokyo (se não, os casos de fuso não provam nada)', async () => {
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const r = await DatabaseConnection.getInstance().getPool().query('SHOW TimeZone');
    expect(r.rows[0].TimeZone).toBe('Asia/Tokyo');
    expect(OPERATION_TIMEZONE).toBe('America/Argentina/Buenos_Aires');
  });

  it('1. permissão: sem enquadre_event:read → 403; sem vacancy:read → 403; com as duas → 200', async () => {
    const q = '?from=2031-01-01&to=2031-01-02';
    expect((await get(q, UID_SO_VAGA)).status).toBe(403);
    expect((await get(q, UID_SO_EVENTO)).status).toBe(403);
    const ok = await get(q, UID_FULL);
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
  });

  it('2. semana: sem datas, entra CURRENT_WEEK_START + 30 min e fica fora CURRENT_WEEK_START − 30 min (domingo 23:30 BA)', async () => {
    const dentro = await evento({ vac: vacAR, startsAt: `${CURRENT_WEEK_START_SQL} + interval '30 minutes'`, sql: true });
    const fora = await evento({ vac: vacAR, startsAt: `${CURRENT_WEEK_START_SQL} - interval '30 minutes'`, sql: true });
    const semana = await admin.query(
      `SELECT ((${CURRENT_WEEK_START_SQL} AT TIME ZONE '${OPERATION_TIMEZONE}')::date)::text AS d_from,
              ((${CURRENT_WEEK_START_SQL} AT TIME ZONE '${OPERATION_TIMEZONE}')::date + 6)::text AS d_to`,
    );
    const res = await get('?limit=100');
    expect(res.status).toBe(200);
    const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(dentro);
    expect(ids).not.toContain(fora);
    expect(res.body.data.range).toEqual({ from: semana.rows[0].d_from, to: semana.rows[0].d_to, defaulted: true });
  });

  it('3. fuso do filtro: com a sessão em Tóquio, from=to=D inclui D 23:30 BA e exclui D+1 00:30 BA', async () => {
    const dentro = await evento({ vac: vacAR, startsAt: ba('2031-05-10', '23:30') });
    const fora = await evento({ vac: vacAR, startsAt: ba('2031-05-11', '00:30') });
    const res = await get('?from=2031-05-10&to=2031-05-10');
    expect(res.status).toBe(200);
    expect((res.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([dentro]);
    expect(res.body.data.total).toBe(1);
    expect(fora).toBeTruthy();
    expect(res.body.data.range).toEqual({ from: '2031-05-10', to: '2031-05-10', defaulted: false });
  });

  it('4. totais do conjunto: 25 eventos, limit=20&offset=20 → 5 itens, total=25, convokedTotal = soma dos 25; removed não conta', async () => {
    const w = [await novoWorker(), await novoWorker(), await novoWorker(), await novoWorker()];
    const esperado: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const status = i === 23 ? 'cancelled' : i === 24 ? 'open' : 'closed';
      const id = await evento({ vac: vacAR, startsAt: DateTime.fromISO(ba('2031-03-01', '10:00')).plus({ hours: i }).toISO() as string, status });
      const conta = 1 + (i % 3);
      for (let k = 0; k < conta; k += 1) {
        // status 'open': UMA participação ativa (a trava um-aberto-por-prestador×vaga só deixa o `w[0]` uma vez).
        await participante(id, vacAR, w[k], status === 'cancelled' ? 'cancelled' : status === 'open' ? null : 'closed');
        if (status === 'open') break;
      }
      esperado.push(status === 'open' ? 1 : conta);
      if (i % 5 === 0) await participante(id, vacAR, w[3], 'removed');
    }
    const soma = esperado.reduce((a, b) => a + b, 0);
    const doUltimaPagina = esperado.slice(20).reduce((a, b) => a + b, 0);
    expect(soma).not.toBe(doUltimaPagina); // controle: somar só a página daria outro número

    const res = await get('?from=2031-03-01&to=2031-04-15&limit=20&offset=20');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(5);
    expect(res.body.data.total).toBe(25);
    expect(res.body.data.convokedTotal).toBe(soma);
    const ultimos = res.body.data.items as Array<{ convokedCount: number; phase: string }>;
    expect(ultimos.map((i) => i.convokedCount)).toEqual(esperado.slice(20));
    expect(ultimos[3].phase).toBe('cancelled');
  });

  it('5. país: evento BR invisível a ator só-AR; country=BR para ator só-AR → 403 COUNTRY_SCOPE_REQUIRED', async () => {
    const ar = await evento({ vac: vacAR, startsAt: ba('2031-07-10', '10:00') });
    const br = await evento({ vac: vacBR, country: 'BR', startsAt: ba('2031-07-10', '11:00') });
    const noBanco = await admin.query(`SELECT count(*)::int AS n FROM enquadre_events WHERE id = ANY($1)`, [[ar, br]]);
    expect(noBanco.rows[0].n).toBe(2); // controle: o BR EXISTE no banco
    const res = await get('?from=2031-07-10&to=2031-07-10');
    expect(res.status).toBe(200);
    expect((res.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([ar]);
    expect(res.body.data.scope).toEqual({ countries: ['AR'], requested: 'ALL' });
    const negado = await get('?from=2031-07-10&to=2031-07-10&country=BR');
    expect(negado.status).toBe(403);
    expect(negado.body.code).toBe('COUNTRY_SCOPE_REQUIRED');
  });

  it('6. intervalo: 92 dias → 200; 93 → 400 TOO_LONG; to<from → 400 INVERTED; só um lado → 400 INCOMPLETE', async () => {
    const from = DateTime.fromISO('2031-08-01');
    const dia = (n: number) => from.plus({ days: n }).toISODate();
    expect((await get(`?from=${dia(0)}&to=${dia(91)}`)).status).toBe(200);
    const longo = await get(`?from=${dia(0)}&to=${dia(92)}`);
    expect(longo.status).toBe(400);
    expect(longo.body.code).toBe('ENQUADRE_LIST_RANGE_TOO_LONG');
    const invertido = await get(`?from=${dia(5)}&to=${dia(4)}`);
    expect(invertido.status).toBe(400);
    expect(invertido.body.code).toBe('ENQUADRE_LIST_RANGE_INVERTED');
    const incompleto = await get(`?from=${dia(0)}`);
    expect(incompleto.status).toBe(400);
    expect(incompleto.body.code).toBe('ENQUADRE_LIST_RANGE_INCOMPLETE');
  });

  it('7. privacidade: a resposta inteira não tem nome/sobrenome/e-mail do paciente, do convocado nem do entrevistador', async () => {
    const id = await evento({ vac: vacAR, startsAt: ba('2031-09-10', '10:00'), host: HOST_NAME_2, importStatus: 'blocked', blockedReason: 'meet_scope_missing' });
    await participante(id, vacAR, await novoWorker(), 'closed');
    const res = await get('?from=2031-09-10&to=2031-09-10');
    expect(res.status).toBe(200);
    // controle positivo: a resposta NÃO está vazia — tem o evento, o entrevistador (nome de exibição) e o selo de bloqueio
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ id, hostName: HOST_NAME_2, convokedCount: 1, importBlocked: { reason: 'meet_scope_missing' } });
    const emailConvocado = (await admin.query(`SELECT email FROM workers WHERE id = ANY($1)`, [workers])).rows.map((r) => r.email as string);
    for (const proibido of [PATIENT_FIRST, PATIENT_LAST, WORKER_NAME_MARK, HOST_EMAIL, ...emailConvocado, '@example.test']) {
      expect(res.text).not.toContain(proibido);
    }
  });
});
