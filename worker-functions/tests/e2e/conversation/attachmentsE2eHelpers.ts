/**
 * attachmentsE2eHelpers.ts — setup compartilhado dos 3 e2e de anexo (spec 022, Bloco 3: T311
 * upload, T314 download, T317 formatos válidos/inválidos). Extraído para não triplicar o mesmo
 * seed de usuário/célula/paciente/bucket em 3 arquivos (zero código repetido, `revisao-pr`) — não
 * é um `.test.ts`, então o `testMatch` do `jest.config.e2e.js` não o roda como suíte própria.
 *
 * Molde: `adminConversation.e2e.test.ts` (harness de família única) + `patient-photo.e2e.test.ts`
 * (fake-gcs real via `GCS_EMULATOR_HOST`, chave de service-account fake gerada em runtime).
 */
import { Pool } from 'pg';
import {
  montarAppDeFamilia,
  tokenMock,
  grupoComCelulas,
  limparIamFixtures,
  garantirCelula,
  TENANT_E2E,
  type AppDeFamilia,
} from '../helpers/permissionFamilyHarness';
import { ensureFakeGcsServiceAccountKey } from '../helpers/fakeGcsServiceAccount';

export const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
export const FAKE_GCS_URL = process.env.GCS_EMULATOR_HOST || 'http://localhost:54463';
export const DOCUMENTS_BUCKET = process.env.PATIENT_DOCUMENTS_BUCKET || 'enlite-patient-documents-b3test';
export const COUNTRY = 'AR';

export const CELULAS_CONVERSA: ReadonlyArray<readonly [string, string]> = [
  ['patient_conversation', 'read'],
  ['patient_conversation', 'create'],
  ['patient_conversation', 'update'],
  ['patient_conversation', 'delete'],
];

export async function ensureBucket(name: string): Promise<void> {
  await fetch(`${FAKE_GCS_URL}/storage/v1/b`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).catch(() => undefined);
}

export interface AttachmentsFixture {
  pool: Pool;
  app: AppDeFamilia;
  patient: string;
  patientOutro: string;
  uidCompleta: string;
  uidOutroCompleta: string;
  uidSemCelula: string;
}

/** `prefix` isola ids/uids entre os 3 arquivos (upload/download/formats) rodando na mesma stack. */
export async function setupAttachmentsFixture(prefix: string): Promise<AttachmentsFixture> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  await ensureBucket(DOCUMENTS_BUCKET);

  const patient = `ee461000-${prefix}-0001-0001-000000000001`;
  const patientOutro = `ee461000-${prefix}-0002-0001-000000000001`;
  const uidCompleta = `e022-b3-${prefix}-completa`;
  const uidOutroCompleta = `e022-b3-${prefix}-outro`;
  const uidSemCelula = `e022-b3-${prefix}-sem-celula`;
  const grupoNome = `E022 B3 ${prefix} Completa`;

  await cleanupAttachmentsFixture(pool, { patient, patientOutro, uids: [uidCompleta, uidOutroCompleta, uidSemCelula], grupos: [grupoNome] });

  await pool.query(
    `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
       ($1, $4 || '@e2e.local', 'Completa', 'admin', 'ACTIVE', true, $5),
       ($2, $4 || '-outro@e2e.local', 'Outro', 'admin', 'ACTIVE', true, $5),
       ($3, $4 || '-sem-celula@e2e.local', 'SemCelula', 'admin', 'ACTIVE', true, $5)`,
    [uidCompleta, uidOutroCompleta, uidSemCelula, `e022-b3-${prefix}`, TENANT_E2E],
  );

  for (const [resource, action] of CELULAS_CONVERSA) {
    await garantirCelula(pool, { resource, action, category: 'Pacientes' });
  }
  await grupoComCelulas(pool, {
    nome: grupoNome,
    uid: uidCompleta,
    celulas: CELULAS_CONVERSA.map(([resource, action]): [string, string] => [resource, action]),
  });
  await pool.query(
    `INSERT INTO iam.user_groups (user_id, group_id, tenant_id) SELECT $1, id, $2 FROM iam.permission_groups WHERE name = $3`,
    [uidOutroCompleta, TENANT_E2E, grupoNome],
  );

  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
       ($1, $3, 'Paciente', 'Sintetico', $4, true),
       ($2, $3 || '-outro', 'Paciente', 'Outro', $4, true)`,
    [patient, patientOutro, `e2e-022-b3-${prefix}`, COUNTRY],
  );

  process.env.USE_MOCK_AUTH = 'true';
  process.env.PERMISSION_ENGINE_ENABLED = 'true';
  process.env.PERMISSION_ENFORCED_ROUTES = 'admin.patients';
  process.env.PERMISSION_CACHE_TTL_MS = '0';
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.GCS_EMULATOR_HOST = FAKE_GCS_URL;
  process.env.PATIENT_DOCUMENTS_BUCKET = DOCUMENTS_BUCKET;
  process.env.GCP_PROJECT_ID = 'enlite-test';
  process.env.GOOGLE_APPLICATION_CREDENTIALS = ensureFakeGcsServiceAccountKey();

  const { createAdminConversationRoutes } = await import('../../../src/modules/conversation/interfaces/routes/adminConversationRoutes');
  const app = await montarAppDeFamilia({
    enforcedRoutes: 'admin.patients',
    montarRotas: ({ app: express, auth, permissions }) => express.use('/api/admin', createAdminConversationRoutes(auth, permissions)),
  });

  return { pool, app, patient, patientOutro, uidCompleta, uidOutroCompleta, uidSemCelula };
}

export async function cleanupAttachmentsFixture(
  pool: Pool,
  opts: { patient: string; patientOutro: string; uids: string[]; grupos: string[] },
): Promise<void> {
  await limparIamFixtures(pool, { uids: opts.uids, grupos: opts.grupos });
  await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[opts.patient, opts.patientOutro]]); // CASCADE: conversations → messages → attachments/stored_files
}

export async function teardownAttachmentsFixture(fixture: AttachmentsFixture, grupoNome: string): Promise<void> {
  await fixture.app.fechar();
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
  await cleanupAttachmentsFixture(fixture.pool, {
    patient: fixture.patient,
    patientOutro: fixture.patientOutro,
    uids: [fixture.uidCompleta, fixture.uidOutroCompleta, fixture.uidSemCelula],
    grupos: [grupoNome],
  });
  await fixture.pool.end();
}

export async function chamar(app: AppDeFamilia, metodo: string, caminho: string, uid: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}${caminho}`, {
    method: metodo,
    headers: { Authorization: tokenMock(uid, 'admin', COUNTRY) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function upload(
  app: AppDeFamilia,
  caminho: string,
  uid: string,
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.set('file', new Blob([buffer], { type: mimetype }), filename);
  const res = await fetch(`${app.url}${caminho}`, {
    method: 'POST',
    headers: { Authorization: tokenMock(uid, 'admin', COUNTRY) },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
