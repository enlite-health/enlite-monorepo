/**
 * patient-diagnoses-rls-context.e2e.test.ts — ficha D, item 2 (CID-11), banco real com RLS.
 *
 * PROVA o conserto medido na stage (15/09): `POST /api/admin/patients/:id/diagnoses` devolvia
 * 500 `Failed to record diagnosis` — Postgres 42501 `rls_session_without_identity` — porque
 * `PostgresPatientDiagnosisRepository.withTransaction` abria a transação com `this.pool.connect()`
 * CRU (sem `app.user_uid`/`app.user_country`/`app.system_context`), e a satélite
 * `patient_diagnoses_follow_patient` (migration 413) consulta `patients` via `EXISTS`, que sob a
 * policy `patients_country_isolation` (migration 411) recusa em voz alta uma sessão sem
 * identidade.
 *
 * Conecta como role de LOGIN membro de `app_runtime` (não-owner, sem BYPASSRLS) — o mesmo molde
 * de `tests/e2e/country-context-app.test.ts`/`dual-pool-routing.test.ts`, mas aqui exercitando o
 * REPOSITÓRIO REAL (`PostgresPatientDiagnosisRepository` → `DatabaseConnection.getInstance()`),
 * não SQL cru — é o caminho que `RecordPatientDiagnosis.writeUnderLock` percorre de verdade.
 *
 * `InMemoryTerminology` no lugar do catálogo ICD-11 real: o que este arquivo prova é RLS/contexto
 * de transação, não a resolução terminológica (já coberta em `patient-diagnoses-api.e2e.test.ts`).
 *
 * Env (`DATABASE_URL`, `COUNTRY_RLS_ENABLED`) é setado ANTES do primeiro `require` de
 * `DatabaseConnection`/`PostgresPatientDiagnosisRepository` — o pool é singleton por processo, e
 * Jest isola o module registry por ARQUIVO de teste, então isto não vaza para outros arquivos.
 */
import { Pool } from 'pg';

const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:55499/enlite_e2e';
const RUNTIME_USER = 'e2e_diag_rls_runtime';
const RUNTIME_PASSWORD = 'e2e_diag_rls_pw';

describe('conserto ficha D/2 — withTransaction carimba contexto ANTES do INSERT/UPDATE (banco real, RLS)', () => {
  let adminPool: Pool;
  let patientId = '';

  // Importados DEPOIS de setar DATABASE_URL/COUNTRY_RLS_ENABLED no beforeAll (ver header).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;

  const AUTISM_URI = 'http://id.who.int/icd/release/11/2026-01/mms/6A02';

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL });

    await adminPool.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_USER}') THEN
          CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PASSWORD}';
        END IF;
      END $$;`);
    await adminPool.query(`GRANT app_runtime TO ${RUNTIME_USER}`);

    const { rows: [p] } = await adminPool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('diag-rls-e2e-task', 'RLS', 'ContextE2E', 'AR', 'ACTIVE') RETURNING id`,
    );
    patientId = p.id;

    const url = new URL(ADMIN_DATABASE_URL);
    url.username = RUNTIME_USER;
    url.password = RUNTIME_PASSWORD;
    process.env.DATABASE_URL = url.toString();
    process.env.COUNTRY_RLS_ENABLED = 'true';
    delete process.env.DB_HOST; // garante o ramo `DATABASE_URL` do construtor (dev/local)

    mod = {
      DatabaseConnection: require('@shared/database/DatabaseConnection').DatabaseConnection,
      loggingAls: require('@shared/logging').loggingAls,
      requestDbSession: require('@shared/database/requestDbSession'),
      PostgresPatientDiagnosisRepository:
        require('../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository')
          .PostgresPatientDiagnosisRepository,
      DiagnosisSource: require('../../src/modules/diagnosis/domain/DiagnosisSource').DiagnosisSource,
      RecordPatientDiagnosis: require('../../src/modules/diagnosis/application/RecordPatientDiagnosis')
        .RecordPatientDiagnosis,
      InMemoryTerminology: require('../../src/modules/terminology/infrastructure/InMemoryTerminology')
        .InMemoryTerminology,
      IcdCode: require('../../src/modules/terminology/domain/IcdCode').IcdCode,
    };
  });

  afterAll(async () => {
    await adminPool.query(`DELETE FROM patient_diagnoses WHERE patient_id = $1`, [patientId]);
    await adminPool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await mod.DatabaseConnection.getInstance().close();
    await adminPool.query(`REVOKE app_runtime FROM ${RUNTIME_USER}`).catch(() => undefined);
    await adminPool.query(`DROP ROLE IF EXISTS ${RUNTIME_USER}`).catch(() => undefined);
    await adminPool.end();
    delete process.env.COUNTRY_RLS_ENABLED;
  });

  /** Roda `fn` como se fosse uma request com o contexto declarado (molde de country-context-app.test.ts). */
  async function asRequest<T>(context: { kind: 'staff'; uid: string; country: 'AR' | 'BR' } | undefined, fn: () => Promise<T>): Promise<T> {
    const session = { context, released: false };
    try {
      return await mod.loggingAls.run({ traceId: 'diag-rls-e2e', dbSession: session }, fn);
    } finally {
      await mod.requestDbSession.releaseDbSession(session);
    }
  }

  function terminologyFake() {
    const CHAPTER = {
      uri: 'http://id.who.int/icd/release/11/2026-01/mms/chapter06',
      code: mod.IcdCode.parse('06'),
      titleEs: 'Trastornos mentales',
      titleEn: 'Mental disorders',
      chapter: '06',
      release: '2026-01',
      kind: 'chapter',
      isLeaf: false,
      parentUri: null,
    };
    const AUTISM = {
      uri: AUTISM_URI,
      code: mod.IcdCode.parse('6A02.Z'),
      titleEs: 'Trastorno del espectro autista',
      titleEn: 'Autism spectrum disorder',
      chapter: '06',
      release: '2026-01',
      kind: 'stem',
      isLeaf: true,
      parentUri: null,
    };
    return new mod.InMemoryTerminology([CHAPTER, AUTISM]);
  }

  it('1. FELIZ — POST (create) sob contexto staff/AR: outcome created, sem 42501 (o conserto)', async () => {
    const repo = new mod.PostgresPatientDiagnosisRepository(mod.DiagnosisSource.PANEL);
    const useCase = new mod.RecordPatientDiagnosis(terminologyFake(), repo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await asRequest({ kind: 'staff', uid: 'diag-rls-e2e-uid', country: 'AR' }, () =>
      useCase.execute({ patientId, conceptUri: AUTISM_URI, isPrimary: true, actorUid: 'diag-rls-e2e-uid' }),
    );

    expect(result.outcome).toBe('created');
    expect(result.diagnosis.conceptCode.value).toBe('6A02.Z');
    expect(result.diagnosis.isPrimary).toBe(true);

    // Confirma DIRETO no banco (via admin, que bypassa RLS) que a linha realmente gravou —
    // não só que a promise resolveu sem lançar.
    const { rows } = await adminPool.query(
      `SELECT concept_code, source, is_primary FROM patient_diagnoses WHERE patient_id = $1`,
      [patientId],
    );
    expect(rows).toEqual([{ concept_code: '6A02.Z', source: 'PANEL', is_primary: true }]);
  });

  it('2. ALTERNATIVO — sem contexto de request (job legado): falha NOMEADA 42501, nunca 500 genérico nem sucesso silencioso', async () => {
    const repo = new mod.PostgresPatientDiagnosisRepository(mod.DiagnosisSource.PANEL);
    const useCase = new mod.RecordPatientDiagnosis(terminologyFake(), repo);

    await expect(
      asRequest(undefined, () =>
        useCase.execute({ patientId, conceptUri: AUTISM_URI, isPrimary: false, actorUid: 'diag-rls-e2e-uid' }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('3. ALTERNATIVO — PATCH (promotePrimary via SetPrimaryDiagnosis.withTransaction) sob contexto staff: promove sem 42501', async () => {
    const repo = new mod.PostgresPatientDiagnosisRepository(mod.DiagnosisSource.PANEL);

    // Semeia um segundo diagnóstico ativo (não-principal) direto no banco (admin bypassa RLS).
    const { rows: [second] } = await adminPool.query(
      `INSERT INTO patient_diagnoses
         (patient_id, terminology_system, concept_uri, concept_code, concept_title, concept_language,
          concept_group, catalog_release, source, is_primary, created_by, updated_by)
       VALUES ($1, 'ICD-11', 'http://id.who.int/icd/release/11/2026-01/mms/second', '8A62.Z', 'Outro conceito',
               'es', '08', '2026-01', 'PANEL', false, 'diag-rls-e2e-uid', 'diag-rls-e2e-uid')
       RETURNING id`,
      [patientId],
    );

    const { SetPrimaryDiagnosis } = require('../../src/modules/diagnosis/application/SetPrimaryDiagnosis');
    const useCase = new SetPrimaryDiagnosis(repo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await asRequest({ kind: 'staff', uid: 'diag-rls-e2e-uid', country: 'AR' }, () =>
      useCase.execute(patientId, second.id, 'diag-rls-e2e-uid'),
    );

    expect(result.outcome).toBe('ok');
    const { rows } = await adminPool.query(
      `SELECT id, is_primary FROM patient_diagnoses WHERE patient_id = $1 ORDER BY created_at`,
      [patientId],
    );
    const primaryIds = rows.filter((r: { is_primary: boolean }) => r.is_primary).map((r: { id: string }) => r.id);
    expect(primaryIds).toEqual([second.id]);
  });
});
