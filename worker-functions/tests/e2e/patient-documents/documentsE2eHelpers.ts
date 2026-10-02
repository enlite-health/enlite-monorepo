/**
 * documentsE2eHelpers.ts — setup compartilhado do e2e da aba "Documentos" (spec 031). Não é `.test.ts`.
 *
 * HTTP real (app em processo, cadeia de produção via `permissionFamilyHarness`), Postgres real, GCS real
 * (fake-gcs-server via `GCS_EMULATOR_HOST`) — NADA de mock de banco ou storage. As rotas de documento E as
 * de conversa são montadas no MESMO app (o anexo do chat cria documento).
 *
 * DOIS apps no mesmo processo, para provar o engine ABAC LIGADO e DESLIGADO:
 *   - `appLigado`    — `admin.patients` enforçada: decide a CÉLULA (grupo → `patient_document:*`).
 *   - `appDesligado` — família fora de `PERMISSION_ENFORCED_ROUTES` (como prd hoje): `untilEnforced: 'admin'`
 *                      só exige o PAPEL admin; célula não importa (D268).
 * Molde: `tests/e2e/conversation/attachmentsE2eHelpers.ts`.
 *
 * Como rodar (ver o cabeçalho de `patientDocuments.e2e.test.ts`).
 */
import { createHash } from 'crypto';
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
export const DOCUMENTS_BUCKET = process.env.PATIENT_DOCUMENTS_BUCKET || 'enlite-patient-documents-e031';
export const COUNTRY = 'AR';

/** PDF mínimo que passa o pipeline do chat (magic bytes + sem `/JavaScript`). */
export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');

const DOC_CELLS = ['read', 'create', 'update', 'delete'] as const;
const CONV_CELLS = ['read', 'create', 'update', 'delete'] as const;

export interface Actors {
  /** Admin com `patient_document:*` + `patient_conversation:*`. */
  full: string;
  /** Admin só com `patient_document:read` (NÃO tem `patient_conversation:read` — Q11). */
  docRead: string;
  /** Admin só com `patient_conversation:*` (anexa no chat; NÃO tem nenhuma `patient_document:*`). */
  chatOnly: string;
  /** Admin sem nenhum grupo. */
  none: string;
  /** Papel `recruiter` sem grupo (engine desligado: `untilEnforced: 'admin'` o barra). */
  recruiter: string;
}

export interface Patients {
  ligado: { p1: string; p2: string };
  desligado: { p1: string; p2: string };
}

export interface DocumentsFixture {
  pool: Pool;
  appLigado: AppDeFamilia;
  appDesligado: AppDeFamilia;
  actors: Actors;
  patients: Patients;
}

const GRUPOS = {
  full: 'E031 Full',
  docRead: 'E031 DocRead',
  chatOnly: 'E031 ChatOnly',
};
const UIDS: Actors = {
  full: 'e031-full',
  docRead: 'e031-docread',
  chatOnly: 'e031-chatonly',
  none: 'e031-none',
  recruiter: 'e031-recruiter',
};
const PATIENTS: Patients = {
  ligado: { p1: 'ee031000-a001-4000-8000-000000000001', p2: 'ee031000-a002-4000-8000-000000000001' },
  desligado: { p1: 'ee031000-b001-4000-8000-000000000001', p2: 'ee031000-b002-4000-8000-000000000001' },
};
const allPatientIds = (): string[] => [PATIENTS.ligado.p1, PATIENTS.ligado.p2, PATIENTS.desligado.p1, PATIENTS.desligado.p2];

async function ensureBucket(name: string): Promise<void> {
  await fetch(`${FAKE_GCS_URL}/storage/v1/b`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).catch(() => undefined);
}

async function cleanup(pool: Pool): Promise<void> {
  await limparIamFixtures(pool, { uids: Object.values(UIDS), grupos: Object.values(GRUPOS) });
  await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [allPatientIds()]); // CASCADE: documentos, conversa, arquivos
}

export async function setupDocumentsFixture(): Promise<DocumentsFixture> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  await ensureBucket(DOCUMENTS_BUCKET);
  await cleanup(pool);

  await pool.query(
    `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
       ($1, 'e031-full@e2e.local', 'Full Sintetica', 'admin', 'ACTIVE', true, $6),
       ($2, 'e031-docread@e2e.local', 'DocRead', 'admin', 'ACTIVE', true, $6),
       ($3, 'e031-chatonly@e2e.local', 'ChatOnly', 'admin', 'ACTIVE', true, $6),
       ($4, 'e031-none@e2e.local', 'Nenhuma', 'admin', 'ACTIVE', true, $6),
       ($5, 'e031-recruiter@e2e.local', 'Recrutadora', 'recruiter', 'ACTIVE', true, $6)`,
    [UIDS.full, UIDS.docRead, UIDS.chatOnly, UIDS.none, UIDS.recruiter, TENANT_E2E],
  );

  for (const action of DOC_CELLS) await garantirCelula(pool, { resource: 'patient_document', action, category: 'Pacientes' });
  for (const action of CONV_CELLS) await garantirCelula(pool, { resource: 'patient_conversation', action, category: 'Pacientes' });
  const doc = (acoes: readonly string[]): Array<[string, string]> => acoes.map((a): [string, string] => ['patient_document', a]);
  const conv = (acoes: readonly string[]): Array<[string, string]> => acoes.map((a): [string, string] => ['patient_conversation', a]);
  await grupoComCelulas(pool, { nome: GRUPOS.full, uid: UIDS.full, celulas: [...doc(DOC_CELLS), ...conv(CONV_CELLS)] });
  await grupoComCelulas(pool, { nome: GRUPOS.docRead, uid: UIDS.docRead, celulas: doc(['read']) });
  await grupoComCelulas(pool, { nome: GRUPOS.chatOnly, uid: UIDS.chatOnly, celulas: conv(CONV_CELLS) });

  for (const [i, id] of allPatientIds().entries()) {
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, $2, 'Paciente', $3, $4, true)`,
      [id, `e2e-031-${i}`, `Sintetico ${i}`, COUNTRY],
    );
  }

  process.env.USE_MOCK_AUTH = 'true';
  process.env.PERMISSION_ENGINE_ENABLED = 'true';
  process.env.PERMISSION_CACHE_TTL_MS = '0';
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.GCS_EMULATOR_HOST = FAKE_GCS_URL;
  process.env.PATIENT_DOCUMENTS_BUCKET = DOCUMENTS_BUCKET;
  process.env.GCP_PROJECT_ID = 'enlite-test';
  process.env.GOOGLE_APPLICATION_CREDENTIALS = ensureFakeGcsServiceAccountKey();

  const { createAdminConversationRoutes } = await import('../../../src/modules/conversation/interfaces/routes/adminConversationRoutes');
  const { createPatientDocumentsRoutes } = await import('../../../src/modules/patient-documents/interfaces/routes/patientDocumentsRoutes');
  const montar = (enforcedRoutes: string): Promise<AppDeFamilia> =>
    montarAppDeFamilia({
      enforcedRoutes,
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/api/admin', createAdminConversationRoutes(auth, permissions));
        express.use('/api/admin', createPatientDocumentsRoutes(auth, permissions));
      },
    });

  return {
    pool,
    appLigado: await montar('admin.patients'),
    appDesligado: await montar(''),
    actors: UIDS,
    patients: PATIENTS,
  };
}

export async function teardownDocumentsFixture(fixture: DocumentsFixture): Promise<void> {
  await fixture.appLigado.fechar();
  await fixture.appDesligado.fechar();
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
  await cleanup(fixture.pool);
  await fixture.pool.end();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

export interface Res {
  status: number;
  body: any;
}

export async function call(
  app: AppDeFamilia,
  method: string,
  path: string,
  uid: string,
  opts: { json?: unknown; role?: string } = {},
): Promise<Res> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      Authorization: tokenMock(uid, opts.role ?? (uid === UIDS.recruiter ? 'recruiter' : 'admin'), COUNTRY),
      ...(opts.json === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function postForm(
  app: AppDeFamilia,
  path: string,
  uid: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
  fields: Record<string, string> = {},
): Promise<Res> {
  const form = new FormData();
  form.set('file', new Blob([file.buffer], { type: file.mimetype }), file.filename);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: { Authorization: tokenMock(uid, uid === UIDS.recruiter ? 'recruiter' : 'admin', COUNTRY) },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export const docsPath = (patientId: string): string => `/api/admin/patients/${patientId}/documents`;
export const convPath = (patientId: string): string => `/api/admin/patients/${patientId}/conversation`;

/** Sobe pelo chat (upload separado) e posta a mensagem com o anexo — o caminho real do front. */
export async function postChatMessageWithFile(
  app: AppDeFamilia,
  patientId: string,
  uid: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
  body = 'mensagem com anexo',
): Promise<{ fileId: string; message: Res }> {
  const up = await postForm(app, `${convPath(patientId)}/files`, uid, file);
  if (up.status !== 201) throw new Error(`upload de anexo do chat falhou: ${up.status}`);
  const fileId = up.body.data.fileId as string;
  const message = await call(app, 'POST', `${convPath(patientId)}/messages`, uid, { json: { body, fileIds: [fileId] } });
  return { fileId, message };
}

// ── fake-gcs / banco ───────────────────────────────────────────────────────────────────────────

export const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
/** O e2e roda com `NODE_ENV=test` → KMS em passthrough base64: o que o banco guarda decifra assim. */
export const fromPassthrough = (cipher: string): string => Buffer.from(cipher, 'base64').toString('utf8');

export async function gcsObjectBytes(objectPath: string): Promise<Buffer | null> {
  const res = await fetch(`${FAKE_GCS_URL}/storage/v1/b/${DOCUMENTS_BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fake-gcs respondeu ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function gcsObjectCount(prefix: string): Promise<number> {
  const res = await fetch(`${FAKE_GCS_URL}/storage/v1/b/${DOCUMENTS_BUCKET}/o?prefix=${encodeURIComponent(prefix)}`);
  const json = (await res.json()) as { items?: unknown[] };
  return json.items?.length ?? 0;
}
