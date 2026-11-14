/**
 * seed-e2e-itinerario-teste.ts — monta EM PRD (enlite-prd; massa is_test, D664) a cadeia de teste até um
 * prestador de teste com alocação ACTIVE num slot do itinerário (spec 077, FND-11):
 * paciente → endereço → serviço contratado (com faixas) → projeto
 * terapêutico → vacante is_test+is_draft → vínculo vacante↔serviço → prestador de teste →
 * candidatura em Equipe de Resposta Rápida → alocação.
 *
 * Uso (de worker-functions/, com `gcloud` autenticado, o proxy de escrita de prd na 5436 e `SEED_ADMIN_TOKEN`; ver tasks/kit/prd-env.sh):
 *   npx ts-node scripts/seed-e2e-itinerario-teste.ts            # monta (idempotente: 2ª execução só reusa)
 *   npx ts-node scripts/seed-e2e-itinerario-teste.ts --cleanup  # desfaz SÓ o que este script criou
 *   cloud-sql-proxy --port 5436 enlite-prd:southamerica-west1:enlite-ar-db
 *
 * Regras duras (cada uma tem teste em scripts/__tests__/seed-e2e-itinerario-teste.test.ts):
 *  - ALVO SÓ O WF DE PRD: `assertE2eApiUrl`/`assertE2eDsn` rodam ANTES de qualquer rede/credencial; host fora da lista = recusa.
 *  - IDEMPOTENTE: cada recurso é achado pelo MARCADOR ("QA077") antes de criar; 2ª execução não duplica.
 *  - CANAL: só rotas que não falam com terceiro. NUNCA activate-recruitment, publish-talentum, sync-talentum,
 *    move de etapa de FUNNEL_STAGES (SELECTED etc.; o StageMessageHandler não filtra is_test) nem data/link de entrevista;
 *    a entrada no pool é por QUICK_RESPONSE_TEAM, que não emite evento.
 *  - Nenhum PII/segredo em log: só IDs e status. A senha da conta QA vem do Secret Manager e não é impressa.
 *  - O SQL é fallback de DUAS lacunas da API (a rota pode faltar no build): vincular vacante↔serviço
 *    (`link-existing-vacancy`, spec 079, só na main) e criar a candidatura (o match exige prestador REGISTERED).
 *    Cada SQL só toca linhas is_test do próprio marcador.
 */
import { execFileSync, spawnSync } from 'node:child_process';

// ── alvo: prd (massa is_test), e só ele ─────────────────────────────────────────────────────────────────────
export const E2E_PROJECT = 'enlite-prd';
export const E2E_API_HOSTS: readonly string[] = ['worker-functions-byh3gvl5yq-tl.a.run.app'];
export const E2E_API_URL = `https://${E2E_API_HOSTS[0]}`;
export const E2E_DSN = 'postgresql://enlite_app@127.0.0.1:5436/enlite_ar';

export function assertE2eApiUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('seed-e2e: URL base inválida — só o WF de prd é aceito');
  }
  if (u.protocol !== 'https:' || !E2E_API_HOSTS.includes(u.hostname) || u.port !== '') {
    throw new Error(`seed-e2e: RECUSADO — host "${u.hostname}" não é o WF de ${E2E_PROJECT}`);
  }
  return `${u.protocol}//${u.hostname}`;
}

export function assertE2eDsn(dsn: string): string {
  const u = new URL(dsn);
  if (u.hostname !== '127.0.0.1' || u.port !== '5436' || u.pathname !== '/enlite_ar') {
    throw new Error(`seed-e2e: RECUSADO — DSN ${u.hostname}:${u.port} não é o proxy de escrita de prd (127.0.0.1:5436)`);
  }
  return dsn;
}

// ── marcador e dados sintéticos (nada de dado real, nada clínico) ───────────────────────────
export const MARK = 'QA077';
const PATIENT_FIRST = MARK;
const PATIENT_LAST = 'Paciente Itinerario';
const TEXT_MARK = `${MARK} massa sintetica de teste, sem conteudo clinico real.`;
const WORKER_EMAIL = 'qa.worker.at@enlite.test';
const WORKER_SECRET = 'qa-prd-worker-at-password';

export interface WorkerAccount { email: string; secret: string }

/** Conta de prestador do seed: padrão `qa.worker.at`; `SEED_WORKER_EMAIL`/`SEED_WORKER_SECRET` trocam (só qa.*@enlite.test e qa-prd-worker-*). */
export function workerAccount(env: NodeJS.ProcessEnv): WorkerAccount {
  const email = env.SEED_WORKER_EMAIL ?? WORKER_EMAIL;
  const secret = env.SEED_WORKER_SECRET ?? WORKER_SECRET;
  if (!/^qa\.[a-z0-9.]+@enlite\.test$/.test(email)) throw new Error('seed-e2e: RECUSADO — e-mail do prestador fora de qa.*@enlite.test');
  if (!/^qa-prd-worker-[a-z0-9-]+$/.test(secret)) throw new Error('seed-e2e: RECUSADO — secret do prestador fora de qa-prd-worker-*');
  return { email, secret };
}
const SCHEDULE = [
  { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 },
  { dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 },
];
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const DX_URI = 'http://id.who.int/icd/release/11/2026-01/mms/437815624';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── dependências injetáveis (o teste troca por fakes) ───────────────────────────────────────
export interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
}
export interface SeedDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{ status: number; text(): Promise<string> }>;
  getToken: (email: string, secret: string) => string;
  getAdminToken: () => string;
  sql: (statement: string, vars: Record<string, string>) => string;
  log: (line: string) => void;
}

export function realDeps(): SeedDeps {
  return {
    fetch: (url, init) => fetch(url, init as RequestInit),
    getToken: e2eIdToken,
    getAdminToken: () => {
      const t = process.env.SEED_ADMIN_TOKEN;
      if (!t) throw new Error('seed-e2e: SEED_ADMIN_TOKEN ausente (export SEED_ADMIN_TOKEN=$(tok_admin))');
      return t;
    },
    sql: runPsql,
    log: (l) => console.log(l),
  };
}

const gcloud = (...args: string[]): string => execFileSync('gcloud', args, { encoding: 'utf8' }).trim();

/** idToken Firebase de prd de uma conta QA (e-mail+senha do Secret Manager) — o token nunca é impresso. */
export function e2eIdToken(email: string, secret: string): string {
  const keyName = gcloud('services', 'api-keys', 'list', `--project=${E2E_PROJECT}`, '--format=value(name)', '--filter=displayName~Browser').split('\n')[0];
  const key = gcloud('services', 'api-keys', 'get-key-string', keyName, `--project=${E2E_PROJECT}`, '--format=value(keyString)');
  const password = gcloud('secrets', 'versions', 'access', 'latest', `--secret=${secret}`, `--project=${E2E_PROJECT}`);
  const r = spawnSync(
    'curl',
    ['-s', '-m', '60', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-', `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`],
    { input: JSON.stringify({ email, password, returnSecureToken: true }), encoding: 'utf8' },
  );
  const token = (JSON.parse(r.stdout || '{}') as { idToken?: string }).idToken;
  if (!token) throw new Error(`seed-e2e: login da conta QA falhou (${email})`);
  return token;
}

/** psql no proxy de escrita de prd; valores entram por `-v` + `:'var'` (nunca concatenados). `VERBOSITY=terse`: DETAIL de erro ecoa a linha. */
export function runPsql(statement: string, vars: Record<string, string>): string {
  assertE2eDsn(E2E_DSN);
  const password = gcloud('secrets', 'versions', 'access', 'latest', '--secret=enlite-ar-db-password', `--project=${E2E_PROJECT}`);
  const env = { ...process.env, PGPASSWORD: password };
  const args = [E2E_DSN, '-v', 'VERBOSITY=terse', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-F', '|'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync('psql', [...args, '-f', '-'], { input: `\\set VERBOSITY terse\n${statement}\n`, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seed-e2e: psql rc=${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  return (r.stdout || '').trim();
}

// ── cliente HTTP do seed ─────────────────────────────────────────────────────────────────────
export class Api {
  private tokens = new Map<string, string>();
  constructor(readonly base: string, private readonly deps: SeedDeps, private readonly worker: WorkerAccount) {}

  private token(email: string, secret: string): string {
    let t = this.tokens.get(email);
    if (!t) {
      t = this.deps.getToken(email, secret);
      this.tokens.set(email, t);
    }
    return t;
  }

  private adminToken(): string {
    let t = this.tokens.get('admin');
    if (!t) {
      t = this.deps.getAdminToken();
      this.tokens.set('admin', t);
    }
    return t;
  }

  async call(method: string, path: string, body?: unknown, who: 'admin' | 'worker' = 'admin'): Promise<HttpResult> {
    const t = who === 'admin' ? this.adminToken() : this.token(this.worker.email, this.worker.secret);
    const res = await this.deps.fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* corpo não-JSON (ex.: 404 do express) */
    }
    return { status: res.status, json };
  }

  /** Exige um dos status; o erro leva só método, rota, status e `code` (nunca o corpo). */
  async must(ok: number[], method: string, path: string, body?: unknown, who: 'admin' | 'worker' = 'admin'): Promise<Record<string, unknown>> {
    const r = await this.call(method, path, body, who);
    if (!ok.includes(r.status)) {
      const code = (r.json?.code ?? r.json?.error ?? '') as string;
      throw new Error(`seed-e2e: ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} → ${r.status} ${String(code).slice(0, 80)}`);
    }
    return (r.json?.data ?? {}) as Record<string, unknown>;
  }
}

type Row = Record<string, unknown>;
const asRows = (d: unknown, key?: string): Row[] => {
  const v = key && d && typeof d === 'object' && !Array.isArray(d) ? (d as Row)[key] : d;
  return Array.isArray(v) ? (v as Row[]) : [];
};
const asId = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`seed-e2e: id inválido em ${label}`);
  return v;
};

export interface SeedIds {
  patientId: string;
  addressId: string;
  serviceId: string;
  projectId: string;
  vacancyId: string;
  workerId: string;
  applicationId: string;
  slotIds: string[];
  allocationIds: string[];
}

/**
 * Linha `workers` da conta QA: `POST /api/workers/init` com corpo `{}` (NUNCA telefone: dispararia o Twilio Verify),
 * idempotente (200 = já existia, 201 = criada) → `GET /api/workers/me` → `test-flag` is_test ANTES de qualquer outra coisa.
 */
export async function ensureTestWorker(api: Api, deps: SeedDeps): Promise<string> {
  void deps;
  const init = await api.must([200, 201], 'POST', '/api/workers/init', {}, 'worker');
  if (init.status === 'claim_pending') throw new Error('seed-e2e: init devolveu claim_pending — recusando seguir');
  const me = await api.must([200], 'GET', '/api/workers/me', undefined, 'worker');
  const workerId = asId(me.id, 'worker');
  await api.must([200], 'PATCH', `/api/admin/workers/${workerId}/test-flag`, { isTest: true });
  return workerId;
}

/** Zona-base sintética (Mar del Plata; a base do VG-01). */
export const ZONA_BASE = { lat: -38.0023, lng: -57.5575 };

const GENERAL_INFO = {
  firstName: MARK, lastName: 'Prestadora Teste', sex: 'Hombre', gender: 'Masculino', birthDate: '1990-01-01',
  documentType: 'DNI', documentNumber: `${MARK}-AT-0001`, phone: '1100000077', languages: ['Español'], profession: 'AT',
  knowledgeLevel: 'INTERMEDIATE', titleCertificate: 'SI', yearsExperience: '5', experienceTypes: ['ELDERLY_CARE'],
  preferredTypes: ['ELDERLY_CARE'], preferredAgeRange: ['ADULT'], termsAccepted: true, privacyAccepted: true,
};
/** Perfil da 2ª prestadora (`--substitute`, D670): telefone e documento próprios (`idx_workers_phone_unique`). */
export const GENERAL_INFO_SUBST = { ...GENERAL_INFO, lastName: 'Substituta Teste', documentNumber: `${MARK}-SUB-0001`, phone: '1100000078' };
const SERVICE_AREA = { address: `${MARK} zona sintetica, Mar del Plata`, serviceRadiusKm: 100, ...ZONA_BASE, city: 'Mar del Plata' };
const AVAILABILITY = { availability: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00', crossesMidnight: false }] };
const DOC_TYPES = ['identity_document', 'criminal_record', 'resume_cv', 'at_certificate'];

/** Completa o cadastro da conta QA só pelas rotas da própria prestadora (valores sintéticos fixos; sem OTP/Twilio nessas rotas). */
export async function completeTestWorker(api: Api, deps: SeedDeps, info: Record<string, unknown> = GENERAL_INFO): Promise<void> {
  await api.must([200, 201], 'PUT', '/api/workers/me/general-info', info, 'worker');
  await api.must([200, 201], 'PUT', '/api/workers/me/service-area', SERVICE_AREA, 'worker');
  await api.must([200, 201], 'PUT', '/api/workers/me/availability', AVAILABILITY, 'worker');
  for (const docType of DOC_TYPES) {
    const up = await api.must([200, 201], 'POST', '/api/workers/me/documents/upload-url', { docType, contentType: 'image/png' }, 'worker');
    const put = await deps.fetch(String(up.signedUrl), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_1X1 });
    if (put.status >= 300) throw new Error(`seed-e2e: upload ${docType} → ${put.status}`);
    await api.must([200, 201], 'POST', '/api/workers/me/documents/save', { docType, filePath: up.filePath }, 'worker');
  }
}

/** init → test-flag → completa o cadastro → exige REGISTERED (senão lança ANTES de qualquer SQL). Devolve o worker id. */
export async function prepararPrestadora(api: Api, deps: SeedDeps, info: Record<string, unknown> = GENERAL_INFO): Promise<string> {
  const workerId = await ensureTestWorker(api, deps);
  await completeTestWorker(api, deps, info);
  const me = await api.must([200], 'GET', '/api/workers/me', undefined, 'worker');
  if (me.status !== 'REGISTERED') {
    const missing = Array.isArray(me.missingFields) ? (me.missingFields as unknown[]).map(String).join(',') : '?';
    throw new Error(`seed-e2e: prestadora não ficou REGISTERED (status=${String(me.status)}; missingFields=${missing})`);
  }
  return workerId;
}

/** Modo `--worker-only`: só a linha `workers` is_test da conta (init {} → me → test-flag); sem cadastro, zona nem alocação. */
export async function seedWorkerOnly(api: Api, deps: SeedDeps): Promise<string> {
  const workerId = await ensureTestWorker(api, deps);
  deps.log(`[seed] OK | worker-only | prestador=${workerId}`);
  return workerId;
}

/** Pool: QUICK_RESPONSE_TEAM (não emite evento; nenhuma data/link de entrevista); só worker e vaga is_test. Devolve a candidatura. */
export function entrarNoPool(deps: SeedDeps, workerId: string, vacancyId: string): string {
  const out = deps.sql(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at)
     SELECT :'w'::uuid, :'v'::uuid, 'QUICK_RESPONSE_TEAM', 'manual', now(), now()
      WHERE EXISTS (SELECT 1 FROM workers WHERE id = :'w'::uuid AND is_test = true)
        AND EXISTS (SELECT 1 FROM job_postings WHERE id = :'v'::uuid AND is_test = true)
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING;
     SELECT id, application_funnel_stage FROM worker_job_applications WHERE worker_id = :'w'::uuid AND job_posting_id = :'v'::uuid;`,
    { w: workerId, v: vacancyId },
  );
  const [applicationRaw, etapa] = out.split('|');
  const applicationId = asId(applicationRaw?.trim(), 'application');
  if (etapa?.trim() !== 'QUICK_RESPONSE_TEAM') throw new Error(`seed-e2e: candidatura em etapa inesperada (${etapa?.trim()}) — o seed nunca move etapa`);
  deps.log(`[seed] pool | candidatura em ${etapa.trim()} | ${applicationId}`);
  return applicationId;
}

/**
 * Modo `--substitute` (D670): 2ª prestadora de teste (conta própria, nunca a at) REGISTERED com perfil próprio e no pool
 * QUICK_RESPONSE_TEAM da vaga da massa (`--vacancy`), SEM alocação (quem aloca é a troca do teste). Idempotente.
 */
export async function seedSubstituta(api: Api, deps: SeedDeps, vacancyId: string): Promise<string> {
  const workerId = await prepararPrestadora(api, deps, GENERAL_INFO_SUBST);
  const applicationId = entrarNoPool(deps, workerId, vacancyId);
  deps.log(`[seed] OK | substituta | prestador=${workerId}`);
  for (const l of [`WORKER_ID=${workerId}`, `APPLICATION_ID=${applicationId}`, `VACANCY_ID=${vacancyId}`]) deps.log(l);
  return workerId;
}

export const VAGAS_RAIO_KM = [3, 12, 60] as const;
export const SOBRENOMES_DO_MARCADOR: readonly string[] = [PATIENT_LAST, 'Paciente Dos', 'Paciente Tres', ...VAGAS_RAIO_KM.map((km) => `Vaga ${km}km`)];

/** Ponto `km` ao norte da base (1° de latitude ≈ 111,32 km), 7 casas. */
export function pontoAoNorte(base: { lat: number; lng: number }, km: number): { lat: number; lng: number } {
  return { lat: Number((base.lat + km / 111.32).toFixed(7)), lng: base.lng };
}

/** 3 pacientes is_test + 3 vagas is_test/is_draft a 3, 12 e 60 km da zona da prestadora (VG-01 F). Nunca publica; coordenada por SQL só em endereço de paciente is_test. */
export async function seedVagasRaio(api: Api, deps: SeedDeps, workerId: string): Promise<Array<{ km: number; vacancyId: string }>> {
  const log = (step: string, status: string, id?: string): void => deps.log(`[seed] ${step} | ${status}${id ? ` | ${id}` : ''}`);
  const out: Array<{ km: number; vacancyId: string }> = [];
  for (const km of VAGAS_RAIO_KM) {
    const last = `Vaga ${km}km`;
    const found = asRows(await api.must([200], 'GET', `/api/admin/patients?search=${MARK}`)).filter((p) => p.firstName === PATIENT_FIRST && p.lastName === last && !p.deletedAt);
    let patientId: string;
    let caseNumber: unknown;
    if (found.length > 0) {
      patientId = asId(found[0].id, 'patient');
      caseNumber = found[0].caseNumber;
    } else {
      const c = await api.must([201], 'POST', '/api/admin/patients', { firstName: PATIENT_FIRST, lastName: last, country: 'AR', contactEmail: `qa077.vaga${km}km@sintetico.invalid` });
      patientId = asId(c.id, 'patient');
      caseNumber = c.caseNumber;
      log(`vaga${km}km.paciente`, 'criado', patientId);
    }
    await api.must([200], 'PATCH', `/api/admin/patients/${patientId}/test-flag`, { isTest: true });
    if (caseNumber === undefined) {
      caseNumber = (asRows(await api.must([200], 'GET', `/api/admin/patients?search=${MARK}`)).find((p) => p.id === patientId) ?? {}).caseNumber;
    }
    const addresses = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/addresses`)).filter((a) => typeof a.address_formatted === 'string' && (a.address_formatted as string).startsWith(MARK));
    let addressId: string;
    if (addresses.length > 0) {
      addressId = asId(addresses[0].id, 'address');
    } else {
      const c = await api.must([201], 'POST', `/api/admin/patients/${patientId}/addresses`, { address_formatted: `${MARK} Vaga ${km}km, Mar del Plata`, is_default: true });
      addressId = asId(c.id, 'address');
      log(`vaga${km}km.endereco`, 'criado', addressId);
    }
    const pt = pontoAoNorte(ZONA_BASE, km);
    const n = deps.sql(
      `UPDATE patient_addresses SET lat = :'lat'::numeric, lng = :'lng'::numeric WHERE id = :'addr'::uuid AND patient_id IN (SELECT id FROM patients WHERE is_test = true) RETURNING 1;`,
      { lat: String(pt.lat), lng: String(pt.lng), addr: addressId },
    );
    if (n !== '1') throw new Error(`seed-e2e: coordenada da vaga ${km}km não casou paciente is_test`);
    const vacancies = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/vacancies`)).filter((v) => !v.deleted_at);
    let vacancyId: string;
    if (vacancies.length > 0) {
      vacancyId = asId(vacancies[0].id, 'vacancy');
    } else {
      const c = await api.must([201], 'POST', '/api/admin/vacancies', { patient_id: patientId, case_number: caseNumber, patient_address_id: addressId, is_test: true, is_draft: true });
      vacancyId = asId(c.id, 'vacancy');
      log(`vaga${km}km.vacante`, 'criada', vacancyId);
    }
    out.push({ km, vacancyId });
  }
  deps.log(`ZONA_WORKER_ID=${workerId}`);
  for (const v of out) deps.log(`VAGA_${v.km}KM_ID=${v.vacancyId}`);
  return out;
}

/** Linhas KEY=valor que o T-F0b-16 lê (`grep '^X='`). */
export function linhasDeIds(ids: SeedIds): string[] {
  return [`PATIENT_ID=${ids.patientId}`, `SERVICE_ID=${ids.serviceId}`, `APPLICATION_ID=${ids.applicationId}`, `WORKER_ID=${ids.workerId}`, `VACANCY_ID=${ids.vacancyId}`];
}

// ── a cadeia ─────────────────────────────────────────────────────────────────────────────────
export interface PacienteSeed {
  firstName: string;
  lastName: string;
  contactEmail: string;
  address: string;
  schedule: Array<{ dayOfWeek: number; startTime: string; durationMinutes: number }>;
}

/** 3 pacientes da qa.worker.at: 2 com o mesmo 1º nome (QA077); faixas em dias distintos (1/3, 2, 4) para não cruzar a alocação. */
export const PACIENTES_SEED: readonly PacienteSeed[] = [
  { firstName: PATIENT_FIRST, lastName: PATIENT_LAST, contactEmail: 'qa077.paciente@sintetico.invalid', address: `${MARK} Av. Corrientes 1000, Buenos Aires`, schedule: SCHEDULE },
  { firstName: PATIENT_FIRST, lastName: 'Paciente Dos', contactEmail: 'qa077.paciente2@sintetico.invalid', address: `${MARK} Av. Santa Fe 2000, Buenos Aires`, schedule: [{ dayOfWeek: 2, startTime: '08:00', durationMinutes: 240 }] },
  { firstName: `${MARK}Tres`, lastName: 'Paciente Tres', contactEmail: 'qa077.paciente3@sintetico.invalid', address: `${MARK} Av. Cordoba 3000, Buenos Aires`, schedule: [{ dayOfWeek: 4, startTime: '08:00', durationMinutes: 240 }] },
];

/** Cadeia de um paciente: paciente → endereço → serviço → cobertura/CID → projeto → vacante → vínculo → candidatura → alocação. */
export async function seedCadeiaPaciente(api: Api, deps: SeedDeps, pac: PacienteSeed, workerId: string): Promise<SeedIds> {
  const log = (step: string, status: string, id?: string): void => deps.log(`[seed] ${step} | ${status}${id ? ` | ${id}` : ''}`);

  // 1. paciente de teste (achado pelo marcador; is_test sempre reafirmado)
  const found = asRows((await api.must([200], 'GET', `/api/admin/patients?search=${MARK}`)), undefined)
    .filter((p) => p.firstName === pac.firstName && p.lastName === pac.lastName && !p.deletedAt);
  let patientId: string;
  if (found.length > 0) {
    patientId = asId(found[0].id, 'patient');
    log('paciente', 'reusado', patientId);
  } else {
    const c = await api.must([201], 'POST', '/api/admin/patients', {
      firstName: pac.firstName, lastName: pac.lastName, country: 'AR', contactEmail: pac.contactEmail,
    });
    patientId = asId(c.id, 'patient');
    log('paciente', 'criado', patientId);
  }
  await api.must([200], 'PATCH', `/api/admin/patients/${patientId}/test-flag`, { isTest: true });
  log('paciente.is_test', 'true', patientId);

  // 2. endereço (em prd o POST geocodifica pelo Google: custo por chamada)
  const addresses = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/addresses`))
    .filter((a) => typeof a.address_formatted === 'string' && (a.address_formatted as string).startsWith(MARK));
  let addressId: string;
  if (addresses.length > 0) {
    addressId = asId(addresses[0].id, 'address');
    log('endereco', 'reusado', addressId);
  } else {
    const c = await api.must([201], 'POST', `/api/admin/patients/${patientId}/addresses`, { address_formatted: pac.address, is_default: true });
    addressId = asId(c.id, 'address');
    log('endereco', 'criado', addressId);
  }

  // 3. serviço contratado com faixas (NÃO chama activate-recruitment)
  const services = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/contracted-services`), 'services')
    .filter((s) => typeof s.requiredExperience === 'string' && (s.requiredExperience as string).startsWith(MARK) && s.active === true);
  let serviceId: string;
  if (services.length > 0) {
    serviceId = asId(services[0].id, 'service');
    log('servico', 'reusado', serviceId);
  } else {
    const c = await api.must([201], 'POST', `/api/admin/patients/${patientId}/contracted-services`, {
      serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId, schedule: pac.schedule,
      requiredProfessions: ['AT'], requiredSex: 'BOTH', requiredExperience: MARK, workSchedule: 'part-time', paymentDay: 'dia 5',
    });
    serviceId = asId(c.id, 'service');
    log('servico', 'criado', serviceId);
  }

  // 3b. completude que a rota link-existing-vacancy cobra (blockers COVERAGE e DIAGNOSIS): cobertura "Particular" + 1 CID-11 do catálogo
  await api.must([200], 'PATCH', `/api/admin/patients/${patientId}/coverage`, { healthInsuranceName: 'Particular' });
  const dxAll = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/diagnoses`), 'diagnoses');
  if (dxAll.length === 0) {
    await api.must([201], 'POST', `/api/admin/patients/${patientId}/diagnoses`, { conceptUri: DX_URI, isPrimary: true });
    log('diagnostico', 'criado (catalogo CID-11)', patientId);
  } else {
    log('diagnostico', 'reusado', patientId);
  }
  log('cobertura', 'Particular', patientId);

  // 5. projeto terapêutico (catálogos existentes; texto é só o marcador, sem conteúdo clínico)
  const versions = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/therapeutic-projects`), 'versions')
    .filter((v) => v.clinicalContext === TEXT_MARK && !v.annulledAt);
  let projectId: string;
  if (versions.length > 0) {
    projectId = asId(versions[0].id, 'project');
    log('projeto-terapeutico', 'reusado', projectId);
  } else {
    const firstActive = async (kind: string): Promise<string> => {
      const it = asRows(await api.must([200], 'GET', `/api/admin/therapeutic-catalogs/${kind}`), 'items').find((i) => i.active === true);
      return asId(it?.id, `catalogo ${kind}`);
    };
    const c = await api.must([201], 'POST', `/api/admin/patients/${patientId}/therapeutic-projects`, {
      mode: 'new',
      version: {
        contractedServiceId: serviceId, modality: 'IN_PERSON', segmentId: await firstActive('segments'),
        diagnoses: [{ uri: DX_URI, title: 'Trastorno del espectro autista' }],
        clinicalContext: TEXT_MARK, generalObjective: TEXT_MARK,
        specificObjectiveIds: [await firstActive('specific-objectives')], activityIds: [await firstActive('activities')],
        startDate: '2026-11-01', endDate: '2027-10-31',
        contactStatus: { RESPONSIBLE: 'NOT_NEEDED', EXTERNAL: 'NOT_NEEDED', COVERAGE: 'NOT_NEEDED', CARE_TEAM: 'NOT_NEEDED' },
      },
    });
    projectId = asId(c.id, 'project');
    log('projeto-terapeutico', 'criado', projectId);
  }

  // 6. vacante is_test + is_draft (NUNCA publish-talentum / sync-talentum)
  const vacancies = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/vacancies`)).filter((v) => !v.deleted_at);
  let vacancyId: string;
  if (vacancies.length > 0) {
    vacancyId = asId(vacancies[0].id, 'vacancy');
    log('vacante', 'reusada', vacancyId);
  } else {
    const caseNumber = (asRows(await api.must([200], 'GET', `/api/admin/patients?search=${MARK}`)).find((p) => p.id === patientId) ?? {}).caseNumber;
    const c = await api.must([201], 'POST', '/api/admin/vacancies', {
      patient_id: patientId, case_number: caseNumber, patient_address_id: addressId, is_test: true, is_draft: true,
    }); // sem campos de recrutamento: o CHECK service_owns_fields proíbe a cópia na vaga com serviço (o dono é o serviço)
    vacancyId = asId(c.id, 'vacancy');
    log('vacante', 'criada', vacancyId);
  }

  // 7. vínculo vacante↔serviço: se a rota não existir no build → SQL só nas linhas is_test do marcador
  const live = ((asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/contracted-services`), 'services').find((s) => s.id === serviceId) ?? {}).liveVacancy ?? null) as { id?: string } | null;
  if (live?.id === vacancyId) {
    log('vinculo-vacante', 'reusado', vacancyId);
  } else {
    const r = await api.call('POST', `/api/admin/patients/${patientId}/contracted-services/${serviceId}/link-existing-vacancy`, { vacancyId });
    if (r.status === 200 || r.status === 201) {
      log('vinculo-vacante', 'criado (rota link-existing-vacancy)', vacancyId);
    } else if (r.status === 404 && r.json === null) {
      const n = deps.sql(
        `UPDATE job_postings SET contracted_service_id = :'svc'::uuid, providers_needed = NULL, schedule = NULL, age_range_min = NULL, age_range_max = NULL, required_sex = NULL, required_professions = NULL, required_experience = NULL, work_schedule = NULL, payment_day = NULL, updated_at = now()
          WHERE id = :'vac'::uuid AND patient_id = :'pat'::uuid AND is_test = true AND contracted_service_id IS NULL
          RETURNING 1;`,
        { svc: serviceId, vac: vacancyId, pat: patientId },
      );
      if (n !== '1') throw new Error('seed-e2e: vínculo vacante↔serviço por SQL não casou nenhuma linha is_test');
      log('vinculo-vacante', 'criado (SQL: rota ausente)', vacancyId);
    } else {
      throw new Error(`seed-e2e: link-existing-vacancy → ${r.status}`);
    }
  }

  // 9. pool: QUICK_RESPONSE_TEAM (não emite evento; nenhuma data/link de entrevista)
  const applicationId = entrarNoPool(deps, workerId, vacancyId);

  // 10. alocação ACTIVE nas faixas (cobrem todo o horário do serviço)
  const itinerary = async (): Promise<Row[]> => asRows(((await api.must([200], 'GET', `/api/admin/patients/${patientId}/itinerary`)).services as unknown), undefined);
  const svcDto = (await itinerary()).find((s) => s.contractedServiceId === serviceId) ?? {};
  const slots = asRows(svcDto.slots);
  if (slots.length === 0) throw new Error('seed-e2e: o serviço não tem faixas');
  const allocationIds: string[] = [];
  for (const slot of slots) {
    const slotId = asId(slot.id, 'slot');
    const mine = asRows(slot.assignments).find((a) => a.workerId === workerId);
    if (mine) {
      allocationIds.push(asId(mine.allocationId ?? mine.id, 'allocation'));
      log('alocacao', `reusada slot=${slotId}`, String(mine.allocationId ?? mine.id));
    } else {
      const c = await api.must([201], 'POST', `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}/allocations`, { workerId });
      allocationIds.push(asId(c.allocationId ?? c.id, 'allocation'));
      log('alocacao', `criada slot=${slotId}`, String(c.allocationId ?? c.id));
    }
  }
  return { patientId, addressId, serviceId, projectId, vacancyId, workerId, applicationId, slotIds: slots.map((s) => s.id as string), allocationIds };
}

export async function seed(api: Api, deps: SeedDeps): Promise<SeedIds> {
  const log = (step: string, status: string, id?: string): void => deps.log(`[seed] ${step} | ${status}${id ? ` | ${id}` : ''}`);
  // 8. prestador de teste: conta QA, is_test ANTES de completar o cadastro (só pelas rotas da própria prestadora)
  const workerId = await prepararPrestadora(api, deps);
  log('prestador.is_test', 'true', workerId);
  log('prestador.status', 'REGISTERED', workerId);
  await seedVagasRaio(api, deps, workerId);

  let first: SeedIds | undefined;
  for (const [idx, pac] of PACIENTES_SEED.entries()) {
    const ids = await seedCadeiaPaciente(api, deps, pac, workerId);
    if (idx === 0) first = ids;
    else deps.log(`PATIENT${idx + 1}_ID=${ids.patientId}`);
  }
  return first as SeedIds;
}

// ── limpeza: só o que o seed criou (por marcador/IDs) — nunca /test-fixtures/cleanup ──────────
export async function cleanup(api: Api, deps: SeedDeps): Promise<void> {
  const log = (step: string, status: string, id?: string): void => deps.log(`[cleanup] ${step} | ${status}${id ? ` | ${id}` : ''}`);
  const patients = asRows(await api.must([200], 'GET', `/api/admin/patients?search=${MARK}`))
    .filter((p) => typeof p.firstName === 'string' && p.firstName.startsWith(PATIENT_FIRST) && typeof p.lastName === 'string' && SOBRENOMES_DO_MARCADOR.includes(p.lastName) && !p.deletedAt);
  for (const p of patients) {
    const patientId = asId(p.id, 'patient');
    if (p.isTest !== true) throw new Error('seed-e2e: paciente do marcador sem is_test — recusando limpar');
    // alocações ativas encerradas pela rota oficial (motivo OTHER, destino RESERVE)
    const svcs = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/contracted-services`), 'services');
    const itin = asRows((await api.must([200], 'GET', `/api/admin/patients/${patientId}/itinerary`)).services as unknown);
    for (const s of itin) {
      for (const slot of asRows(s.slots)) {
        for (const a of asRows(slot.assignments)) {
          const allocationId = asId(a.allocationId ?? a.id, 'allocation');
          const e = await api.call('POST', `/api/admin/patients/${patientId}/contracted-services/${String(s.contractedServiceId)}/itinerary/allocations/${allocationId}/end`, { reasonCategory: 'OTHER', destination: 'RESERVE' });
          if (e.status !== 200 && e.status !== 201 && !(e.status === 422 && e.json?.code === 'ALLOCATION_NOT_ACTIVE')) throw new Error(`seed-e2e: end allocation → ${e.status}`);
          log('alocacao', e.status === 422 ? 'ja encerrada' : 'encerrada', allocationId);
        }
      }
    }
    void svcs;
    // candidaturas das vacantes is_test do paciente (o purge recusa candidatura de prestador não-teste)
    deps.sql(
      `DELETE FROM patient_itinerary_change_log WHERE (assignment_id IN (SELECT a.id FROM patient_itinerary_assignment a WHERE a.slot_id IN (SELECT id FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = :'pat'::uuid)))
          OR new_assignment_id IN (SELECT a.id FROM patient_itinerary_assignment a WHERE a.slot_id IN (SELECT id FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = :'pat'::uuid)))) AND EXISTS (SELECT 1 FROM patients WHERE id = :'pat'::uuid AND is_test = true);
       DELETE FROM patient_itinerary_assignment WHERE slot_id IN (SELECT id FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = :'pat'::uuid)) AND EXISTS (SELECT 1 FROM patients WHERE id = :'pat'::uuid AND is_test = true);
       DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = :'pat'::uuid AND is_test = true) AND EXISTS (SELECT 1 FROM patients WHERE id = :'pat'::uuid AND is_test = true);`,
      { pat: patientId },
    );
    log('candidatura+alocacoes', 'removidas (SQL, só vacante is_test do paciente)', patientId);
    await api.must([200], 'DELETE', `/api/admin/patients/${patientId}`);
    log('paciente', 'purgado (is_test)', patientId);
  }
  if (patients.length === 0) log('paciente', 'ausente');
  // devolve a conta QA ao estado original (INCOMPLETE_REGISTER: os 2 documentos que o seed enviou saem)
  for (const docType of ['criminal_record', 'resume_cv']) {
    const r = await api.call('DELETE', `/api/workers/me/documents/${docType}`, undefined, 'worker');
    log('prestador.documento', `${docType} removido (${r.status})`);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
export async function main(argv: string[], deps: SeedDeps = realDeps(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const i = argv.indexOf('--api-url');
  const base = assertE2eApiUrl(i >= 0 ? argv[i + 1] : E2E_API_URL); // ANTES de qualquer rede, credencial ou SQL
  assertE2eDsn(E2E_DSN);
  const account = workerAccount(env);
  const cleanupMode = argv.includes('--cleanup');
  const workerOnly = argv.includes('--worker-only');
  const substitute = argv.includes('--substitute');
  if (substitute && (cleanupMode || workerOnly)) throw new Error('seed-e2e: --substitute não combina com --cleanup nem --worker-only');
  if (cleanupMode && workerOnly) throw new Error('seed-e2e: --cleanup e --worker-only são exclusivos');
  if (cleanupMode && account.email !== WORKER_EMAIL) throw new Error('seed-e2e: --cleanup só com a conta qa.worker.at');
  if (substitute && account.email === WORKER_EMAIL) throw new Error('seed-e2e: --substitute exige outra conta (SEED_WORKER_EMAIL), nunca a qa.worker.at');
  const v = argv.indexOf('--vacancy');
  const vacancyId = substitute ? asId(v >= 0 ? argv[v + 1] : undefined, '--vacancy') : '';
  const api = new Api(base, deps, account);
  if (cleanupMode) {
    await cleanup(api, deps);
    return;
  }
  if (workerOnly) {
    await seedWorkerOnly(api, deps);
    return;
  }
  if (substitute) {
    await seedSubstituta(api, deps, vacancyId);
    return;
  }
  const ids = await seed(api, deps);
  deps.log(`[seed] OK | alocacoes ACTIVE=${ids.allocationIds.length}`);
  for (const l of linhasDeIds(ids)) deps.log(l);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
