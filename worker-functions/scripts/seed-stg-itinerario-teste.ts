/**
 * seed-stg-itinerario-teste.ts — monta NA STG (enlite-stg, nunca prd) a cadeia de teste até um
 * prestador de teste com alocação ACTIVE num slot do itinerário (spec 077, FND-11):
 * paciente → endereço → serviço contratado (com faixas) → pagador/contrato/vínculo → projeto
 * terapêutico → vacante is_test+is_draft → vínculo vacante↔serviço → prestador de teste →
 * candidatura em Equipe de Resposta Rápida → alocação.
 *
 * Uso (de worker-functions/, com `gcloud` autenticado e o cloud-sql-proxy da stg na 5434):
 *   npx ts-node scripts/seed-stg-itinerario-teste.ts            # monta (idempotente: 2ª execução só reusa)
 *   npx ts-node scripts/seed-stg-itinerario-teste.ts --cleanup  # desfaz SÓ o que este script criou
 *   cloud-sql-proxy --port 5434 enlite-stg:southamerica-west1:enlite-ar-db
 *
 * Regras duras (cada uma tem teste em scripts/__tests__/seed-stg-itinerario-teste.test.ts):
 *  - ALVO SÓ STG: `assertStgApiUrl`/`assertStgDsn` rodam ANTES de qualquer rede/credencial; host fora da lista = recusa.
 *  - IDEMPOTENTE: cada recurso é achado pelo MARCADOR ("QA077") antes de criar; 2ª execução não duplica.
 *  - CANAL: só rotas que não falam com terceiro. NUNCA activate-recruitment, publish-talentum, sync-talentum,
 *    move de etapa de FUNNEL_STAGES (SELECTED etc.; o StageMessageHandler não filtra is_test) nem data/link de entrevista;
 *    a entrada no pool é por QUICK_RESPONSE_TEAM, que não emite evento.
 *  - Nenhum PII/segredo em log: só IDs e status. A senha da conta QA vem do Secret Manager e não é impressa.
 *  - O SQL é fallback de DUAS lacunas da API da stg (build de `stage`, 25/10): vincular vacante↔serviço
 *    (`link-existing-vacancy`, spec 079, só na main) e criar a candidatura (o match exige prestador REGISTERED).
 *    Cada SQL só toca linhas is_test do próprio marcador.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// ── alvo: stg, e só ela ─────────────────────────────────────────────────────────────────────
export const STG_PROJECT = 'enlite-stg';
export const STG_API_HOSTS: readonly string[] = ['worker-functions-vtf37eainq-tl.a.run.app'];
export const STG_API_URL = `https://${STG_API_HOSTS[0]}`;
export const STG_DSN = 'postgresql://enlite_app@127.0.0.1:5434/enlite_ar';

export function assertStgApiUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('seed-stg: URL base inválida — só a stg é aceita');
  }
  if (u.protocol !== 'https:' || !STG_API_HOSTS.includes(u.hostname) || u.port !== '') {
    throw new Error(`seed-stg: RECUSADO — host "${u.hostname}" não é da stg (${STG_PROJECT}); este script nunca roda em prd`);
  }
  return `${u.protocol}//${u.hostname}`;
}

export function assertStgDsn(dsn: string): string {
  const u = new URL(dsn);
  if (u.hostname !== '127.0.0.1' || u.port !== '5434' || u.pathname !== '/enlite_ar') {
    throw new Error(`seed-stg: RECUSADO — DSN ${u.hostname}:${u.port} não é o proxy da stg (127.0.0.1:5434); 5435/5436/5439 são prd`);
  }
  return dsn;
}

// ── marcador e dados sintéticos (nada de dado real, nada clínico) ───────────────────────────
export const MARK = 'QA077';
const PATIENT_FIRST = MARK;
const PATIENT_LAST = 'Paciente Itinerario';
const PROVIDER_CODE = `${MARK}_PAGADOR`;
const PROVIDER_NAME = `${MARK} Pagador sintetico`;
const CONTRACT_NAME = `${MARK} contrato sintetico`;
const TEXT_MARK = `${MARK} massa sintetica de teste, sem conteudo clinico real.`;
const WORKER_EMAIL = 'qa.worker.at@enlite.test';
const WORKER_SECRET = 'qa-stg-worker-at-password';
const ADMIN_EMAIL = 'qa.admin@enlite.test';
const ADMIN_SECRET = 'qa-stg-admin-password';
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
  sql: (statement: string, vars: Record<string, string>) => string;
  log: (line: string) => void;
}

export function realDeps(): SeedDeps {
  return {
    fetch: (url, init) => fetch(url, init as RequestInit),
    getToken: stgIdToken,
    sql: runPsql,
    log: (l) => console.log(l),
  };
}

const gcloud = (...args: string[]): string => execFileSync('gcloud', args, { encoding: 'utf8' }).trim();

/** idToken Firebase da stg de uma conta QA (e-mail+senha do Secret Manager) — o token nunca é impresso. */
export function stgIdToken(email: string, secret: string): string {
  const keyName = gcloud('services', 'api-keys', 'list', `--project=${STG_PROJECT}`, '--format=value(name)', '--filter=displayName:"Browser key (auto created by Firebase)"').split('\n')[0];
  const key = gcloud('services', 'api-keys', 'get-key-string', keyName, `--project=${STG_PROJECT}`, '--format=value(keyString)');
  const password = gcloud('secrets', 'versions', 'access', 'latest', `--secret=${secret}`, `--project=${STG_PROJECT}`);
  const r = spawnSync(
    'curl',
    ['-s', '-m', '60', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-', `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`],
    { input: JSON.stringify({ email, password, returnSecureToken: true }), encoding: 'utf8' },
  );
  const token = (JSON.parse(r.stdout || '{}') as { idToken?: string }).idToken;
  if (!token) throw new Error(`seed-stg: login da conta QA falhou (${email})`);
  return token;
}

/** psql no proxy da stg; valores entram por `-v` + `:'var'` (nunca concatenados). `VERBOSITY=terse`: DETAIL de erro ecoa a linha. */
export function runPsql(statement: string, vars: Record<string, string>): string {
  assertStgDsn(STG_DSN);
  const pwFile = process.env.STG_DB_PASSWORD_FILE ?? `${homedir()}/.enlite-replica/.stg_pw`;
  const env = { ...process.env, PGPASSWORD: readFileSync(pwFile, 'utf8').trim() };
  const args = [STG_DSN, '-v', 'VERBOSITY=terse', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-F', '|'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync('psql', [...args, '-f', '-'], { input: `\\set VERBOSITY terse\n${statement}\n`, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seed-stg: psql rc=${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  return (r.stdout || '').trim();
}

// ── cliente HTTP do seed ─────────────────────────────────────────────────────────────────────
class Api {
  private tokens = new Map<string, string>();
  constructor(readonly base: string, private readonly deps: SeedDeps) {}

  private token(email: string, secret: string): string {
    let t = this.tokens.get(email);
    if (!t) {
      t = this.deps.getToken(email, secret);
      this.tokens.set(email, t);
    }
    return t;
  }

  async call(method: string, path: string, body?: unknown, who: 'admin' | 'worker' = 'admin'): Promise<HttpResult> {
    const t = who === 'admin' ? this.token(ADMIN_EMAIL, ADMIN_SECRET) : this.token(WORKER_EMAIL, WORKER_SECRET);
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
      throw new Error(`seed-stg: ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} → ${r.status} ${String(code).slice(0, 80)}`);
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
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`seed-stg: id inválido em ${label}`);
  return v;
};

export interface SeedIds {
  patientId: string;
  addressId: string;
  serviceId: string;
  contractId: string;
  projectId: string;
  vacancyId: string;
  workerId: string;
  applicationId: string;
  slotIds: string[];
  allocationIds: string[];
}

// ── a cadeia ─────────────────────────────────────────────────────────────────────────────────
export async function seed(api: Api, deps: SeedDeps): Promise<SeedIds> {
  const log = (step: string, status: string, id?: string): void => deps.log(`[seed] ${step} | ${status}${id ? ` | ${id}` : ''}`);

  // 1. paciente de teste (achado pelo marcador; is_test sempre reafirmado)
  const found = asRows((await api.must([200], 'GET', `/api/admin/patients?search=${MARK}`)), undefined)
    .filter((p) => p.firstName === PATIENT_FIRST && p.lastName === PATIENT_LAST && !p.deletedAt);
  let patientId: string;
  if (found.length > 0) {
    patientId = asId(found[0].id, 'patient');
    log('paciente', 'reusado', patientId);
  } else {
    const c = await api.must([201], 'POST', '/api/admin/patients', {
      firstName: PATIENT_FIRST, lastName: PATIENT_LAST, country: 'AR', contactEmail: 'qa077.paciente@sintetico.invalid',
    });
    patientId = asId(c.id, 'patient');
    log('paciente', 'criado', patientId);
  }
  await api.must([200], 'PATCH', `/api/admin/patients/${patientId}/test-flag`, { isTest: true });
  log('paciente.is_test', 'true', patientId);

  // 2. endereço (sem geocode real: a stg não tem chave do Maps)
  const addresses = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/addresses`))
    .filter((a) => typeof a.address_formatted === 'string' && (a.address_formatted as string).startsWith(MARK));
  let addressId: string;
  if (addresses.length > 0) {
    addressId = asId(addresses[0].id, 'address');
    log('endereco', 'reusado', addressId);
  } else {
    const c = await api.must([201], 'POST', `/api/admin/patients/${patientId}/addresses`, { address_formatted: `${MARK} Av. Corrientes 1000, Buenos Aires`, is_default: true });
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
      serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId, schedule: SCHEDULE,
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

  // 4. pagador sintético próprio + contrato + vínculo (o catálogo real nunca é alterado)
  const providers = asRows(await api.must([200], 'GET', `/api/admin/insurance-providers?search=${MARK}&includeInactive=true`), 'items');
  const provider = providers.find((p) => p.code === PROVIDER_CODE);
  if (!provider) {
    await api.must([201], 'POST', '/api/admin/catalogs/insurance-providers', { name: PROVIDER_NAME, code: PROVIDER_CODE });
    log('pagador', 'criado', PROVIDER_CODE);
  } else {
    log('pagador', 'reusado', PROVIDER_CODE);
  }
  await api.must([200], 'PATCH', `/api/admin/insurance-providers/${PROVIDER_CODE}`, { payerKind: 'PRIVATE', active: true });
  const contracts = asRows(await api.must([200], 'GET', `/api/admin/insurance-providers/${PROVIDER_CODE}/contracts`), 'items').filter((c) => c.name === CONTRACT_NAME);
  let contractId: string;
  if (contracts.length > 0) {
    contractId = asId(contracts[0].id, 'contract');
    log('contrato', 'reusado', contractId);
  } else {
    const c = await api.must([201], 'POST', `/api/admin/insurance-providers/${PROVIDER_CODE}/contracts`, {
      name: CONTRACT_NAME, country: 'AR', scopeDescription: `${MARK} massa de teste`, firstTerm: { hourlyRate: 1000, taxRatePercent: 0, validFrom: '2026-01-01' },
    });
    contractId = asId(c.id, 'contract');
    log('contrato', 'criado', contractId);
  }
  const svc = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/contracted-services`), 'services').find((s) => s.id === serviceId) ?? {};
  const payer = (svc.payer ?? {}) as { state?: string; names?: { contractId?: string } };
  if (payer.state === 'LINKED' && payer.names?.contractId === contractId) {
    log('vinculo-contrato', 'reusado', serviceId);
  } else {
    await api.must([201], 'POST', `/api/admin/patients/${patientId}/contracted-services/${serviceId}/contract-link`, { contractId, validFrom: '2026-01-01' });
    log('vinculo-contrato', 'criado', serviceId);
  }

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

  // 7. vínculo vacante↔serviço: rota da main; a stg (build de stage) não a tem → SQL só nas linhas is_test do marcador
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
      if (n !== '1') throw new Error('seed-stg: vínculo vacante↔serviço por SQL não casou nenhuma linha is_test');
      log('vinculo-vacante', 'criado (SQL: rota ausente na stg)', vacancyId);
    } else {
      throw new Error(`seed-stg: link-existing-vacancy → ${r.status}`);
    }
  }

  // 8. prestador de teste: conta QA existente, marcada is_test ANTES de qualquer outra coisa
  const me = await api.must([200], 'GET', '/api/workers/me', undefined, 'worker');
  const workerId = asId(me.id, 'worker');
  await api.must([200], 'PATCH', `/api/admin/workers/${workerId}/test-flag`, { isTest: true });
  log('prestador.is_test', 'true', workerId);
  // completar o cadastro: a candidatura exige status REGISTERED; REGISTERED não se força — só os 2 documentos faltantes (PNG sintético 1x1)
  for (const docType of ['criminal_record', 'resume_cv']) {
    const missing = ((await api.must([200], 'GET', '/api/workers/me', undefined, 'worker')).missingFields ?? []) as string[];
    if (!missing.includes(`doc_${docType}`)) continue;
    const up = await api.must([200, 201], 'POST', '/api/workers/me/documents/upload-url', { docType, contentType: 'image/png' }, 'worker');
    const put = await deps.fetch(String(up.signedUrl), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_1X1 });
    if (put.status >= 300) throw new Error(`seed-stg: upload ${docType} → ${put.status}`);
    await api.must([200, 201], 'POST', '/api/workers/me/documents/save', { docType, filePath: up.filePath }, 'worker');
    log('prestador.documento', `${docType} enviado (sintetico)`, workerId);
  }
  const workerStatus = (await api.must([200], 'GET', '/api/workers/me', undefined, 'worker')).status;
  log('prestador.status', String(workerStatus), workerId);

  // 9. pool: QUICK_RESPONSE_TEAM (não emite evento; nenhuma data/link de entrevista)
  const out = deps.sql(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at)
     SELECT :'w'::uuid, :'v'::uuid, 'QUICK_RESPONSE_TEAM', 'manual', now(), now()
      WHERE EXISTS (SELECT 1 FROM workers WHERE id = :'w'::uuid AND is_test = true)
        AND EXISTS (SELECT 1 FROM job_postings WHERE id = :'v'::uuid AND is_test = true)
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING;
     SELECT id, application_funnel_stage FROM worker_job_applications WHERE worker_id = :'w'::uuid AND job_posting_id = :'v'::uuid;`,
    { w: workerId, v: vacancyId },
  );
  const [applicationRaw, stage] = out.split('|');
  const applicationId = asId(applicationRaw?.trim(), 'application');
  if (stage?.trim() !== 'QUICK_RESPONSE_TEAM') throw new Error(`seed-stg: candidatura em etapa inesperada (${stage?.trim()}) — o seed nunca move etapa`);
  log('pool', `candidatura em ${stage.trim()}`, applicationId);

  // 10. alocação ACTIVE nas faixas (cobrem todo o horário do serviço)
  const itinerary = async (): Promise<Row[]> => asRows(((await api.must([200], 'GET', `/api/admin/patients/${patientId}/itinerary`)).services as unknown), undefined);
  const svcDto = (await itinerary()).find((s) => s.contractedServiceId === serviceId) ?? {};
  const slots = asRows(svcDto.slots);
  if (slots.length === 0) throw new Error('seed-stg: o serviço não tem faixas');
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
  return { patientId, addressId, serviceId, contractId, projectId, vacancyId, workerId, applicationId, slotIds: slots.map((s) => s.id as string), allocationIds };
}

// ── limpeza: só o que o seed criou (por marcador/IDs) — nunca /test-fixtures/cleanup ──────────
export async function cleanup(api: Api, deps: SeedDeps): Promise<void> {
  const log = (step: string, status: string, id?: string): void => deps.log(`[cleanup] ${step} | ${status}${id ? ` | ${id}` : ''}`);
  const patients = asRows(await api.must([200], 'GET', `/api/admin/patients?search=${MARK}`))
    .filter((p) => p.firstName === PATIENT_FIRST && p.lastName === PATIENT_LAST && !p.deletedAt);
  for (const p of patients) {
    const patientId = asId(p.id, 'patient');
    if (p.isTest !== true) throw new Error('seed-stg: paciente do marcador sem is_test — recusando limpar');
    // alocações ativas encerradas pela rota oficial (motivo OTHER, destino RESERVE)
    const svcs = asRows(await api.must([200], 'GET', `/api/admin/patients/${patientId}/contracted-services`), 'services');
    const itin = asRows((await api.must([200], 'GET', `/api/admin/patients/${patientId}/itinerary`)).services as unknown);
    for (const s of itin) {
      for (const slot of asRows(s.slots)) {
        for (const a of asRows(slot.assignments)) {
          const allocationId = asId(a.allocationId ?? a.id, 'allocation');
          const e = await api.call('POST', `/api/admin/patients/${patientId}/contracted-services/${String(s.contractedServiceId)}/itinerary/allocations/${allocationId}/end`, { reasonCategory: 'OTHER', destination: 'RESERVE' });
          if (e.status !== 200 && e.status !== 201 && !(e.status === 422 && e.json?.code === 'ALLOCATION_NOT_ACTIVE')) throw new Error(`seed-stg: end allocation → ${e.status}`);
          log('alocacao', e.status === 422 ? 'ja encerrada' : 'encerrada', allocationId);
        }
      }
    }
    void svcs;
    // candidaturas das vacantes is_test do paciente (o purge recusa candidatura de prestador não-teste)
    deps.sql(
      `DELETE FROM patient_itinerary_change_log WHERE assignment_id IN (SELECT a.id FROM patient_itinerary_assignment a WHERE a.slot_id IN (SELECT id FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = :'pat'::uuid)))
          OR new_assignment_id IN (SELECT a.id FROM patient_itinerary_assignment a WHERE a.slot_id IN (SELECT id FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = :'pat'::uuid)));
       DELETE FROM patient_itinerary_assignment WHERE slot_id IN (SELECT id FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = :'pat'::uuid));
       DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id = :'pat'::uuid AND is_test = true);`,
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
  const providers = asRows(await api.must([200], 'GET', `/api/admin/insurance-providers?search=${MARK}&includeInactive=true`), 'items');
  if (providers.some((p) => p.code === PROVIDER_CODE)) {
    await api.must([200], 'PATCH', `/api/admin/insurance-providers/${PROVIDER_CODE}`, { active: false });
    log('pagador', 'desativado (contrato fica, sem rota de delete)', PROVIDER_CODE);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
export async function main(argv: string[], deps: SeedDeps = realDeps()): Promise<void> {
  const i = argv.indexOf('--api-url');
  const base = assertStgApiUrl(i >= 0 ? argv[i + 1] : STG_API_URL); // ANTES de qualquer rede, credencial ou SQL
  assertStgDsn(STG_DSN);
  const api = new Api(base, deps);
  if (argv.includes('--cleanup')) {
    await cleanup(api, deps);
    return;
  }
  const ids = await seed(api, deps);
  deps.log(`[seed] OK | alocacoes ACTIVE=${ids.allocationIds.length} | paciente=${ids.patientId} prestador=${ids.workerId} vacante=${ids.vacancyId}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
