/**
 * public-vacancy-diagnosis-label.e2e.test.ts — spec 042 (D473), e2e SEM MOCK da rota pública
 * `GET /api/vacancies/:id` (PublicVacancyController real + Express real + Postgres real).
 *
 * O que os unit tests não provam: a leitura do CID roda no contexto `public` (pool `app_system`,
 * policy `patient_diagnoses_follow_patient` liberada por `system_context` + membro de app_system),
 * sem ator e sem `connect()` cru. Aqui o app roda como a role NÃO-owner (`enlite_admin` é
 * superuser com BYPASSRLS e a RLS não valeria), com `COUNTRY_RLS_ENABLED=true` e DOIS pools
 * (runtime e sistema), exatamente como a produção — molde: `vacancy-diagnoses.e2e.test.ts` e
 * `dual-pool-routing.test.ts`.
 *
 * Dado sintético apenas: título `Diagnóstico sintético QA`, códigos `ZZ99.Z`/`ZZ99.Y`.
 * O controle positivo é o caso 1 (rótulo presente): sem ele os `null` dos outros casos não
 * provariam nada (contagem zero é falha).
 */
import { Pool } from 'pg';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
const RUNTIME_USER = 'e2e_pubdiag_runtime';
const SYSTEM_USER = 'e2e_pubdiag_system';
const PASSWORD = 'e2e_pubdiag_pw';

const TITULO = 'Diagnóstico sintético QA';
const TITULO_B = 'Diagnóstico sintético QA B';
const CODIGO_A = 'ZZ99.Z';
const CODIGO_B = 'ZZ99.Y';
const URI_A = 'http://e2e.local/pubdiag/zz99z';
const URI_B = 'http://e2e.local/pubdiag/zz99y';
const TEXTO_LIVRE = 'texto livre sintético QA';
const RUN = `${Date.now()}`;

type Caso = 'feliz' | 'semCid' | 'doisSemPrincipal' | 'doisComPrincipal';

describe('GET /api/vacancies/:id — diagnosisLabel (HTTP real, Postgres real, RLS + pool app_system)', () => {
  let adminPool: Pool;
  let servidor: Server;
  let baseUrl: string;
  const patientIds: Partial<Record<Caso, string>> = {};
  const vacancyIds: Partial<Record<Caso, string>> = {};
  const envAnterior: Record<string, string | undefined> = {};

  function setEnv(chave: string, valor: string | undefined): void {
    envAnterior[chave] = process.env[chave];
    if (valor === undefined) delete process.env[chave];
    else process.env[chave] = valor;
  }

  const urlFor = (user: string): string => {
    const url = new URL(ADMIN_DATABASE_URL);
    url.username = user;
    url.password = PASSWORD;
    return url.toString();
  };

  async function semear(caso: Caso, n: number, diagnosticos: Array<[string, string, string, boolean]>): Promise<void> {
    const p = await adminPool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, diagnosis)
       VALUES ($1, 'QA', 'PubDiag', 'AR', 'ACTIVE', $2) RETURNING id`,
      [`pubdiag-${caso}-${RUN}`, TEXTO_LIVRE],
    );
    patientIds[caso] = p.rows[0].id;
    for (const [titulo, codigo, uri, principal] of diagnosticos) {
      await adminPool.query(
        `INSERT INTO patient_diagnoses
           (patient_id, terminology_system, concept_uri, concept_code, concept_title, concept_language,
            concept_group, catalog_release, source, is_primary, created_by, updated_by)
         VALUES ($1, 'ICD-11', $2, $3, $4, 'es', '06', '2026-01', 'PANEL', $5, 'e2e', 'e2e')`,
        [patientIds[caso], uri, codigo, titulo, principal],
      );
    }
    const v = await adminPool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, is_draft, patient_id, case_number)
       VALUES ($1, 'AR', 'SEARCHING', false, $2, $3) RETURNING id`,
      [`Caso pubdiag E2E ${caso}`, patientIds[caso], 98000 + n],
    );
    vacancyIds[caso] = v.rows[0].id;
  }

  async function getPublica(caso: Caso): Promise<{ status: number; texto: string; body: any }> {
    const res = await fetch(`${baseUrl}/api/vacancies/${vacancyIds[caso]}`);
    const texto = await res.text();
    return { status: res.status, texto, body: JSON.parse(texto) };
  }

  function esperaSemCodigoNemUriNemTextoLivre(texto: string): void {
    for (const proibido of [CODIGO_A, CODIGO_B, 'ZZ99', URI_A, URI_B, 'e2e.local', TEXTO_LIVRE, patientIds.feliz ?? 'x']) {
      expect(texto).not.toContain(proibido);
    }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL });

    for (const [user, grupo] of [[RUNTIME_USER, 'app_runtime'], [SYSTEM_USER, 'app_system']]) {
      await adminPool.query(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN
            CREATE ROLE ${user} LOGIN PASSWORD '${PASSWORD}';
          END IF;
        END $$;`);
      await adminPool.query(`GRANT ${grupo} TO ${user}`);
    }

    await semear('feliz', 1, [[TITULO, CODIGO_A, URI_A, true]]);
    await semear('semCid', 2, []);
    await semear('doisSemPrincipal', 3, [
      [TITULO, CODIGO_A, URI_A, false],
      [TITULO_B, CODIGO_B, URI_B, false],
    ]);
    await semear('doisComPrincipal', 4, [
      [TITULO, CODIGO_A, URI_A, false],
      [TITULO_B, CODIGO_B, URI_B, true],
    ]);

    // Dois pools e RLS de país ANTES do primeiro DatabaseConnection.getInstance().
    setEnv('COUNTRY_RLS_ENABLED', 'true');
    setEnv('DATABASE_URL', urlFor(RUNTIME_USER));
    setEnv('DATABASE_SYSTEM_URL', urlFor(SYSTEM_USER));
    setEnv('DB_HOST', undefined);
    setEnv('DB_SYSTEM_USER', undefined);
    setEnv('DB_SYSTEM_PASSWORD', undefined);

    const express = (await import('express')).default;
    const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
    const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
    const { publicContextMiddleware } = await import('@shared/database/systemContextMiddleware');
    const { PublicVacancyController } = await import('@modules/matching');

    const controller = new PublicVacancyController();
    const app = express();
    app.use(express.json());
    app.use(correlationMiddleware);
    app.use(dbSessionMiddleware);
    // Mesma montagem de `src/index.ts:313` (sem o rate limit, que não é o objeto do teste).
    app.get('/api/vacancies/:id', publicContextMiddleware('public:/api/vacancies/:id'), (req, res) => {
      void controller.getById(req, res);
    });
    servidor = app.listen(0);
    await new Promise<void>((resolve) => servidor.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (servidor ? servidor.close(() => resolve()) : resolve()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();

    const vids = Object.values(vacancyIds).filter(Boolean);
    const pids = Object.values(patientIds).filter(Boolean);
    await adminPool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [vids]);
    // `patient_diagnoses` cai por ON DELETE CASCADE junto com `patients`.
    await adminPool.query(`DELETE FROM patients WHERE id = ANY($1)`, [pids]);
    const sobra = await adminPool.query(`SELECT count(*)::int AS n FROM patient_diagnoses WHERE patient_id = ANY($1)`, [pids]);
    expect(sobra.rows[0].n).toBe(0);
    await adminPool.query(`REVOKE app_runtime FROM ${RUNTIME_USER}`).catch(() => undefined);
    await adminPool.query(`REVOKE app_system FROM ${SYSTEM_USER}`).catch(() => undefined);
    await adminPool.query(`DROP ROLE IF EXISTS ${RUNTIME_USER}`).catch(() => undefined);
    await adminPool.query(`DROP ROLE IF EXISTS ${SYSTEM_USER}`).catch(() => undefined);
    await adminPool.end();
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }, 30000);

  it('precondição: o harness tem DOIS pools distintos (runtime ≠ app_system) e a RLS de país está ligada', async () => {
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const db = DatabaseConnection.getInstance();
    expect(db.getSystemPool()).not.toBe(db.getPool());
    expect(process.env.COUNTRY_RLS_ENABLED).toBe('true');
    const quemSou = await db.getSystemPool().query<{ u: string }>('SELECT current_user AS u');
    expect(quemSou.rows[0].u).toBe(SYSTEM_USER);
  });

  it('controle da RLS: a role runtime, confinada a OUTRO país, não enxerga o CID semeado (a linha existe, a policy filtra)', async () => {
    const direto = await adminPool.query(`SELECT 1 FROM patient_diagnoses WHERE patient_id = $1`, [patientIds.feliz]);
    expect(direto.rowCount).toBe(1);
    const runtime = new Pool({ connectionString: urlFor(RUNTIME_USER), max: 1 });
    const client = await runtime.connect();
    try {
      await client.query(`SELECT set_config('app.user_country', 'BR', false)`);
      const r = await client.query(`SELECT 1 FROM patient_diagnoses WHERE patient_id = $1`, [patientIds.feliz]);
      expect(r.rowCount).toBe(0);
    } finally {
      client.release();
      await runtime.end();
    }
  });

  it('1. FELIZ — 1 CID es → diagnosisLabel === título sintético; sem código, URI nem texto livre no corpo', async () => {
    const { status, body, texto } = await getPublica('feliz');
    expect(status).toBe(200);
    expect(body.data.diagnosisLabel).toBe(TITULO);
    esperaSemCodigoNemUriNemTextoLivre(texto);
  });

  it('2. SEM CID, só texto livre no paciente → diagnosisLabel null e o texto livre ausente do corpo', async () => {
    const { status, body, texto } = await getPublica('semCid');
    expect(status).toBe(200);
    expect(body.data.diagnosisLabel).toBeNull();
    esperaSemCodigoNemUriNemTextoLivre(texto);
  });

  it('3. 2+ CID ativos e NENHUM principal → diagnosisLabel null (não adivinha)', async () => {
    const { status, body, texto } = await getPublica('doisSemPrincipal');
    expect(status).toBe(200);
    expect(body.data.diagnosisLabel).toBeNull();
    esperaSemCodigoNemUriNemTextoLivre(texto);
  });

  it('3b. 2+ CID ativos e 1 principal → o título do principal (controle positivo do caso 2+)', async () => {
    const { status, body, texto } = await getPublica('doisComPrincipal');
    expect(status).toBe(200);
    expect(body.data.diagnosisLabel).toBe(TITULO_B);
    esperaSemCodigoNemUriNemTextoLivre(texto);
  });

  it('em todos os casos as chaves de data são exatamente a lista positiva (21), sem patient_id', async () => {
    const esperadas = [
      'id', 'case_number', 'vacancy_number', 'title', 'status', 'is_disabled', 'service_type',
      'required_professions', 'required_sex', 'age_range_min', 'age_range_max', 'worker_attributes',
      'schedule', 'schedule_days_hours', 'salary_text', 'talentum_description', 'talentum_whatsapp_url',
      'patient_zone', 'country', 'created_at', 'diagnosisLabel',
    ].sort();
    for (const caso of ['feliz', 'semCid', 'doisSemPrincipal', 'doisComPrincipal'] as Caso[]) {
      const { body } = await getPublica(caso);
      expect(Object.keys(body.data).sort()).toEqual(esperadas);
    }
  });
});
