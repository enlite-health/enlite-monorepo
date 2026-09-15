/**
 * patient-photo-and-documents.e2e.test.ts — spec 018, PR-4 (achado 7 da revisão do PR-4: faltava
 * e2e de API contra fake-gcs REAL + Postgres REAL — só existia e2e de UI, via Playwright, contra
 * o front). HTTP real (app em processo, mesmo harness de
 * `patient-coverage-emergency-contacts.e2e.test.ts`), Postgres real, GCS real contra
 * `fake-gcs-server` (`docker-compose.018pr4-ports.yml`).
 *
 * Como rodar:
 *   docker compose -p pr4e2e -f docker-compose.yml -f docker-compose.018pr4-ports.yml up -d postgres fake-gcs
 *   curl -X POST http://localhost:54443/storage/v1/b -d '{"name":"enlite-patient-photos-pr4test"}'
 *   curl -X POST http://localhost:54443/storage/v1/b -d '{"name":"enlite-patient-documents-pr4test"}'
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e \
 *     node scripts/run-migrations-docker.js
 *   npx jest tests/e2e/patient-photo-and-documents.e2e.test.ts --runInBand
 *
 * (`fake-gcs-server` NÃO cria bucket sozinho no primeiro upload — 404 até o POST /storage/v1/b
 * explícito; medido rodando este arquivo contra a stack limpa.)
 *
 * Provas:
 *  1. Foto: upload (multipart, JPEG de verdade — `PatientPhotoProcessor` usa `sharp`, não aceita
 *     bytes arbitrários) → GET assina a URL do objeto CERTO → DELETE apaga a LINHA e o OBJETO do
 *     bucket (confirmado direto na API do fake-gcs — `GET /storage/v1/b/<bucket>/o` — não só pelo
 *     404 da rota, que provaria a linha mas não o bucket).
 *  2. Documento: upload → listagem (metadados, SEM url assinada) → GET por id exige a célula NOVA
 *     `patient_consent_documents:read` (403 sem ela, mesmo já tendo patient_identity:write).
 *  3. Purga (`PatientTestFixtureService`, task 4.8): CASCADE apaga as linhas (foto, documento,
 *     consentimento) E os objetos correspondentes somem do bucket — as duas coisas, não só uma.
 */
import { Pool } from 'pg';
import sharp from 'sharp';
import {
  montarAppDeFamilia,
  tokenMock,
  grupoComCelulas,
  limparIamFixtures,
  garantirCelula,
  TENANT_E2E,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { ensureFakeGcsServiceAccountKey } from './helpers/fakeGcsServiceAccount';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const FAKE_GCS_URL = process.env.GCS_EMULATOR_HOST || 'http://localhost:54443';
const PHOTOS_BUCKET = process.env.GCS_PATIENT_PHOTOS_BUCKET || 'enlite-patient-photos-pr4test';
const DOCUMENTS_BUCKET = process.env.GCS_PATIENT_DOCUMENTS_BUCKET || 'enlite-patient-documents-pr4test';

describe('Patient photo/document/consent — HTTP real, Postgres real, GCS real (fake-gcs) — achado 7 da revisão do PR-4', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const PATIENT = 'ee426000-0c00-0001-0001-000000000001';
  const PURGE_PATIENT = 'ee426000-0c00-0001-0001-000000000002';
  const U = { completa: 'ppd7-completa', semDocs: 'ppd7-sem-docs' };
  const GRUPOS = { completa: 'PPD7 Completa', semDocs: 'PPD7 Sem docs' };
  // PR-8b (A3, ADR-2/SUP-30): as rotas de foto/documento/consentimento não declaram mais
  // `patient_identity:write` — upload é `create`, DELETE/revoke é `update`
  // (`adminPatientPhotoRoutes.ts:61,65,80,102,116`).
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient_identity', 'read'],
    ['patient_identity', 'create'],
    ['patient_identity', 'update'],
    ['patient_consent_documents', 'read'],
  ];
  // Conserto #1 da 3ª revisão do PR-4: só a célula que ESTE suite de fato criou
  // (`garantirCelula` → `criada:true`) é apagada no afterAll — mesmo padrão de
  // `patient-address-principal-tipo.e2e.test.ts`/`permission-enforcement-all-families.e2e.test.ts`.
  // ANTES deste conserto, o `INSERT ... ON CONFLICT DO NOTHING` (linha do beforeAll) inseria as 3
  // células sem `limpar()` jamais apagar a linha de `iam.permissions` — só o `group_permissions`
  // que apontava pra ela — e a suíte deixava `iam.permissions` com 3 linhas a mais toda vez que
  // rodava (medido: `permissions-iam-schema`/`iam-permissions-foundation` esperam 41, viam 44).
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  /** Roda no INÍCIO (limpa resíduo de execução anterior) e no FIM — nunca mexe em `iam.permissions`,
   *  só nas fixtures que este suite é DONO por nome (grupo/uid/patient). */
  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, PURGE_PATIENT]]);
  }

  /** Só no afterAll, e só depois que `celulasCriadas` está populado: apaga a célula do catálogo
   *  (e qualquer grant apontando pra ela) SE ESTE suite foi quem a inseriu — célula pré-existente
   *  (seed 206 ou outra suíte) nunca é tocada. */
  async function limparCelulasCriadas(): Promise<void> {
    for (const [resource, action] of celulasCriadas) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [resource, action],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
  }

  async function ensureBucket(name: string): Promise<void> {
    await fetch(`${FAKE_GCS_URL}/storage/v1/b`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => undefined);
  }

  /** Lista os NOMES de objeto vivos no bucket — direto na API do fake-gcs, sem passar pela API do worker. */
  async function gcsObjectNames(bucket: string): Promise<string[]> {
    const res = await fetch(`${FAKE_GCS_URL}/storage/v1/b/${bucket}/o`);
    const data = (await res.json()) as { items?: Array<{ name: string }> };
    return (data.items ?? []).map((i) => i.name);
  }

  async function objectPathOf(table: string, patientId: string): Promise<string> {
    const { rows } = await pool.query<{ object_path_encrypted: string }>(
      `SELECT object_path_encrypted FROM ${table} WHERE patient_id = $1`,
      [patientId],
    );
    if (rows.length === 0) throw new Error(`nenhuma linha em ${table} para ${patientId}`);
    // KMS em NODE_ENV=test é passthrough base64 (KMSEncryptionService.ts) — decodifica direto.
    return Buffer.from(rows[0].object_path_encrypted, 'base64').toString('utf8');
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function upload(
    caminho: string,
    uid: string,
    buffer: Buffer,
    filename: string,
    mimetype: string,
    campos: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.set(k, v);
    form.set('file', new Blob([buffer], { type: mimetype }), filename);
    const res = await fetch(`${app.url}${caminho}`, {
      method: 'POST',
      headers: { Authorization: tokenMock(uid) },
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** JPEG de verdade (2x2, vermelho) — `PatientPhotoProcessor` usa `sharp.metadata()`, bytes arbitrários viram 422. */
  async function jpegBuffer(): Promise<Buffer> {
    return sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer();
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await ensureBucket(PHOTOS_BUCKET);
    await ensureBucket(DOCUMENTS_BUCKET);

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'ppd7-completa@e2e.local', 'Completa', 'admin', 'ACTIVE', true, $3),
         ($2, 'ppd7-sem-docs@e2e.local', 'Sem docs', 'admin', 'ACTIVE', true, $3)`,
      [U.completa, U.semDocs, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      const { criada } = await garantirCelula(pool, { resource, action, category: 'Pacientes' });
      if (criada) celulasCriadas.push([resource, action]);
    }
    await grupoComCelulas(pool, {
      nome: GRUPOS.completa,
      uid: U.completa,
      celulas: [
        ['patient_identity', 'read'],
        ['patient_identity', 'create'],
        ['patient_identity', 'update'],
        ['patient_consent_documents', 'read'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.semDocs,
      uid: U.semDocs,
      celulas: [
        ['patient_identity', 'read'],
        ['patient_identity', 'create'],
        ['patient_identity', 'update'],
      ],
    });

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-pr4-a', 'Paciente', 'Sintético', 'AR', true),
         ($2, 'e2e-pr4-purge', 'Paciente', 'Purga', 'AR', true)`,
      [PATIENT, PURGE_PATIENT],
    );

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('GCS_EMULATOR_HOST', FAKE_GCS_URL);
    setEnv('GCS_PATIENT_PHOTOS_BUCKET', PHOTOS_BUCKET);
    setEnv('GCS_PATIENT_DOCUMENTS_BUCKET', DOCUMENTS_BUCKET);
    setEnv('GCP_PROJECT_ID', 'enlite-test');
    // Conserto #1 da 2ª revisão do PR-4: NÃO depender de `/tmp/fake-sa.json` montado do host — o
    // CI não tem esse arquivo. A chave fake é gerada aqui mesmo, no setup do teste (idempotente,
    // fica no tmpdir do processo; nunca commitada).
    setEnv('GOOGLE_APPLICATION_CREDENTIALS', ensureFakeGcsServiceAccountKey());

    const caseModule = await import('@modules/case');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', caseModule.createAdminPatientPhotoRoutes(auth, permissions)),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await limparCelulasCriadas();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('1. Foto: upload → linha + objeto no bucket certo; GET assina o objeto certo; DELETE apaga a LINHA e o OBJETO', async () => {
    const buffer = await jpegBuffer();
    const up = await upload(`/api/admin/patients/${PATIENT}/photo`, U.completa, buffer, 'foto.jpg', 'image/jpeg');
    expect(up.status).toBe(201);
    expect(up.body).toEqual({ success: true, data: { hasPhoto: true } });

    const objectPath = await objectPathOf('patient_photos', PATIENT);
    expect(objectPath).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(await gcsObjectNames(PHOTOS_BUCKET)).toContain(objectPath);

    const getUrl = await chamar('GET', `/api/admin/patients/${PATIENT}/photo`, U.completa);
    expect(getUrl.status).toBe(200);
    expect(getUrl.body.data.url).toContain(`/${PHOTOS_BUCKET}/${objectPath}`);
    expect(getUrl.body.data.expiresInSeconds).toBe(300);

    const del = await chamar('DELETE', `/api/admin/patients/${PATIENT}/photo`, U.completa);
    expect(del.status).toBe(204);

    const linhaDepois = await pool.query(`SELECT 1 FROM patient_photos WHERE patient_id = $1`, [PATIENT]);
    expect(linhaDepois.rowCount).toBe(0);
    // A prova que a revisão pediu: o OBJETO sumiu do bucket, não só a linha do banco.
    expect(await gcsObjectNames(PHOTOS_BUCKET)).not.toContain(objectPath);

    const getUrlDepois = await chamar('GET', `/api/admin/patients/${PATIENT}/photo`, U.completa);
    expect(getUrlDepois.status).toBe(404);
  });

  it('2. Documento: upload → listagem (metadados, SEM url) → GET por id exige patient_consent_documents:read (403 sem a célula, mesmo com patient_identity:write)', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake e2e patient document');
    const up = await upload(
      `/api/admin/patients/${PATIENT}/documents`,
      U.completa,
      pdf,
      'consent.pdf',
      'application/pdf',
      { documentType: 'image_consent' },
    );
    expect(up.status).toBe(201);
    const documentId: string = up.body.data.documentId;
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);

    const objectPath = await objectPathOf('patient_documents', PATIENT);
    expect(objectPath).toMatch(/^patient-documents\/[0-9a-f-]{36}$/);
    expect(await gcsObjectNames(DOCUMENTS_BUCKET)).toContain(objectPath);

    const list = await chamar('GET', `/api/admin/patients/${PATIENT}/documents`, U.completa);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: documentId, documentType: 'image_consent', contentType: 'application/pdf' });
    // Achado do próprio PR-4 (comentário do controller): a listagem NUNCA leva url assinada.
    expect(JSON.stringify(list.body)).not.toMatch(/"url"/);

    const getUrl = await chamar('GET', `/api/admin/patients/${PATIENT}/documents/${documentId}`, U.completa);
    expect(getUrl.status).toBe(200);
    expect(getUrl.body.data.url).toContain(`/${DOCUMENTS_BUCKET}/${objectPath}`);

    // 🔒 célula certa: patient_identity:write sozinha NÃO basta para LER a prova documental.
    const listSemCelula = await chamar('GET', `/api/admin/patients/${PATIENT}/documents`, U.semDocs);
    expect(listSemCelula.status).toBe(403);
    const getUrlSemCelula = await chamar('GET', `/api/admin/patients/${PATIENT}/documents/${documentId}`, U.semDocs);
    expect(getUrlSemCelula.status).toBe(403);
  });

  it('3. Purga (PatientTestFixtureService, task 4.8): CASCADE apaga as linhas E os objetos do bucket somem', async () => {
    const photoBuf = await jpegBuffer();
    const upPhoto = await upload(`/api/admin/patients/${PURGE_PATIENT}/photo`, U.completa, photoBuf, 'foto.jpg', 'image/jpeg');
    expect(upPhoto.status).toBe(201);
    const upDoc = await upload(
      `/api/admin/patients/${PURGE_PATIENT}/documents`,
      U.completa,
      Buffer.from('%PDF-1.4 fake purge'),
      'doc.pdf',
      'application/pdf',
      { documentType: 'image_consent' },
    );
    expect(upDoc.status).toBe(201);

    const photoPath = await objectPathOf('patient_photos', PURGE_PATIENT);
    const docPath = await objectPathOf('patient_documents', PURGE_PATIENT);
    expect(await gcsObjectNames(PHOTOS_BUCKET)).toContain(photoPath);
    expect(await gcsObjectNames(DOCUMENTS_BUCKET)).toContain(docPath);

    const { PatientTestFixtureService } = await import('../../src/modules/case/application/PatientTestFixtureService');
    const calendarStub = { deleteEvent: jest.fn(async () => undefined) } as never;
    const svc = new PatientTestFixtureService(pool, calendarStub);

    const result = await svc.purge(PURGE_PATIENT);

    expect(result?.photoObjectsDeleted).toBe(1);
    expect(result?.photoObjectsFailed).toBe(0);
    expect(result?.documentObjectsDeleted).toBe(1);
    expect(result?.documentObjectsFailed).toBe(0);

    const pacienteDepois = await pool.query(`SELECT 1 FROM patients WHERE id = $1`, [PURGE_PATIENT]);
    expect(pacienteDepois.rowCount).toBe(0); // CASCADE levou patient_photos/patient_documents junto

    // A prova que o achado 8 (comentário desatualizado) descrevia mal: os OBJETOS realmente somem.
    expect(await gcsObjectNames(PHOTOS_BUCKET)).not.toContain(photoPath);
    expect(await gcsObjectNames(DOCUMENTS_BUCKET)).not.toContain(docPath);
  }, 15000);
});
