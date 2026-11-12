/**
 * invitar-prestadores-089-helper.ts
 *
 * Seed e leituras do e2e da tela "Invitar prestadores" (spec 089, T042). Espelha o canvas
 * `MatchFlow.dc.html:321-341`: 35 prestadores nos raios/ângulos do board (bandas 0-5/5-10/10-20/20-50 km,
 * ângulo `i × 137,508°`), 3 já convidados em 03/11, 3 "ya en la vacante" (INVITED/manual, sem WhatsApp) e os
 * casos F6 (serviço sem coordenada; ninguém até 50 km com N sem ubicación).
 *
 * REGRA SUPREMA: nenhum canal real. Todo prestador nasce com `messaging_channel='periskope'`: o envio
 * (`MessagingController.sendVacancyMatch`, `:112`) vai ao Periskope, cuja base é `PERISKOPE_BASE_URL`
 * = `host.docker.internal:9911` no stack de teste (`docker-compose.test.yml:120-129`) — o stub da 9911
 * (`startPeriskopeStub`, reusado de `compativeis-e2e-helper.ts`, que GRAVA path + corpo de cada POST).
 * Telefones sintéticos `+549110…`, nomes "Prestadora QA NN"; nenhum dado real, nenhum texto clínico.
 *
 * Reusa sem copiar: `insertTestPatient`/`insertBaseVacancy`/`cleanupTestPatient` (db-test-helper),
 * `nameTrgmBidxSql` (patient-detail-c-helper — busca por nome é blind index), `startPeriskopeStub`/
 * `seedVacancyMatchTemplates` (compativeis-e2e-helper), `tokenFor` (abac-stack-helper), `runSQL`.
 * Só a escrita em LOTE é daqui: um `psql -1` por stdin (35 prestadores em 1 round-trip, não 140).
 */
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import type { APIRequestContext } from '@playwright/test';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from './db-test-helper';
import { nameTrgmBidxSql } from './patient-detail-c-helper';
import { runSQL } from './patient-detail-a-helper';
import { tokenFor, type MockUser } from './abac-stack-helper';
import { startPeriskopeStub, seedVacancyMatchTemplates, type PeriskopeStub } from './compativeis-e2e-helper';

export { startPeriskopeStub, seedVacancyMatchTemplates, type PeriskopeStub };

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';

// ── Geometria do canvas (`MatchFlow.dc.html:321-330`) ──────────────────────────────────────────

/** Av. Santa Fe 3200, Palermo (o serviço do canvas). */
export const SERVICE_LAT = -34.588;
export const SERVICE_LNG = -58.41;
export const SERVICE_LABEL = 'Av. Santa Fe 3200, Palermo';
/** Serviço da vacante C: longe de qualquer prestador do seed (e de massa de outros e2e). Ushuaia. */
const FAR_LAT = -54.8019;
const FAR_LNG = -68.303;

/** `DIST` do canvas (`:322`): 35 distâncias em km, uma por prestador. */
export const CANVAS_DIST_KM = [1.2, 2.0, 2.7, 3.4, 4.1, 4.8, 5.6, 6.3, 6.9, 7.4, 8.0, 8.6, 9.1, 9.5, 9.9, 10.8, 11.9, 12.6, 13.4, 14.2, 15.1, 16.0, 17.3, 18.1, 18.9, 19.6, 21.4, 24.8, 27.2, 31.5, 35.0, 38.7, 42.3, 46.1, 49.2];
/** `BANDS` do canvas (`:323`): `(min, max]`. */
export const BANDS = [{ min: 0, max: 5 }, { min: 5, max: 10 }, { min: 10, max: 20 }, { min: 20, max: 50 }] as const;
/** `BEFORE` do canvas (`:324`): w1, w4, w9 já convidados em 03/11. */
export const PRE_INVITED_INDEXES = [1, 4, 9];
/** 03/11, meio-dia no fuso de Buenos Aires — o dia 03 em AR, não em UTC. */
const PRE_INVITED_AT = "'2026-11-03 12:00:00-03'";

export function bandOf(distKm: number): number {
  return BANDS.findIndex((b) => distKm > b.min && distKm <= b.max);
}

/** Ponto a `distKm` do ponto dado, no rumo `bearingDeg` (esfera de 6371 km, a mesma do `haversineKm` do backend). */
export function destinationPoint(lat: number, lng: number, distKm: number, bearingDeg: number): { lat: number; lng: number } {
  const d = distKm / 6371;
  const th = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lng * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  return { lat: r6((p2 * 180) / Math.PI), lng: r6(((l2 * 180) / Math.PI + 540) % 360 - 180) };
}

// ── psql em lote (stdin) ───────────────────────────────────────────────────────────────────────

function psqlBatch(sql: string): string {
  return execSync(`docker exec -i ${CONTAINER} psql -U enlite_admin -d enlite_e2e -v ON_ERROR_STOP=1 -1 -q -tA`, {
    input: sql,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

// ── Tipos ─────────────────────────────────────────────────────────────────────────────────────

export interface InvitarWorker {
  workerId: string;
  name: string;
  /** Índice no canvas (0-34) ou -1 para os "ya en la vacante". */
  index: number;
  /** `null` = sem área de atuação (sem ubicación). */
  distKm: number | null;
  lat: number | null;
  lng: number | null;
  docsComplete: boolean;
  /** Banda `(min,max]` 0-3; -1 fora de 50 km ou sem área. */
  band: number;
}

export interface InvitarVacancy {
  vacancyId: string;
  patientId: string;
  addressId: string;
  caseNumber: number;
}

export interface Invitar089Seed {
  /** Vacante A: serviço do canvas, 35 prestadores + 3 pendentes. */
  vacancyA: InvitarVacancy & { serviceLat: number; serviceLng: number };
  /** Os 35 do canvas (3 deles já convidados em 03/11). */
  candidates: InvitarWorker[];
  /** Os 3 já convidados em 03/11 (subconjunto de `candidates`). */
  preInvited: InvitarWorker[];
  /** Os 3 "ya en la vacante": [23,4 km docs ok · 61,0 km faltan · sem área docs ok]. */
  pending: InvitarWorker[];
  /** F6: serviço SEM coordenada (a página não deve chamar o POST). */
  vacancyB: InvitarVacancy;
  /** F6: perfil que ninguém cumpre até 50 km; `pendingNoArea` = os N sem ubicación. */
  vacancyC: InvitarVacancy & { pendingNoArea: InvitarWorker[] };
  cleanup: () => void;
}

// ── Seed ──────────────────────────────────────────────────────────────────────────────────────

interface WorkerSpec {
  id: string;
  name: [string, string];
  index: number;
  distKm: number | null;
  bearing: number;
  docsComplete: boolean;
  /** Origem das coordenadas (serviço da vacante A). */
  originLat: number;
  originLng: number;
}

function workersInsertSql(specs: WorkerSpec[], runTag: string): string {
  const rows = specs.map((s, k) => {
    const [first, last] = s.name;
    const phone = `+549110${runTag}${String(k).padStart(2, '0')}`;
    return `('${s.id}', 'e2e089-${s.id}', 'e2e089.${s.id}@test.local', '${phone}', 'REGISTERED', 'AR', 'AT', '${b64(first)}', '${b64(last)}', '${b64('F')}', ${nameTrgmBidxSql(first, last)}, 'periskope')`;
  });
  return `INSERT INTO workers (id, auth_uid, email, phone, status, country, occupation, first_name_encrypted, last_name_encrypted, sex_encrypted, name_trgm_bidx, messaging_channel) VALUES\n${rows.join(',\n')};\n`;
}

function areasInsertSql(specs: WorkerSpec[]): { sql: string; points: Map<string, { lat: number; lng: number }> } {
  const points = new Map<string, { lat: number; lng: number }>();
  const rows: string[] = [];
  for (const s of specs) {
    if (s.distKm === null) continue;
    const p = destinationPoint(s.originLat, s.originLng, s.distKm, s.bearing);
    points.set(s.id, p);
    rows.push(`('${s.id}', 'AR', ${p.lat}, ${p.lng}, 20, 'Zona QA')`);
  }
  const sql = rows.length
    ? `INSERT INTO worker_service_areas (worker_id, country, latitude, longitude, radius_km, work_zone) VALUES\n${rows.join(',\n')};\n`
    : '';
  return { sql, points };
}

function documentsInsertSql(specs: WorkerSpec[]): string {
  const rows = specs.map((s) =>
    s.docsComplete
      ? `('${s.id}', 'https://storage.example.com/resume.pdf', 'https://storage.example.com/identity.pdf', 'https://storage.example.com/criminal.pdf', 'https://storage.example.com/at_cert.pdf', 'submitted')`
      : `('${s.id}', NULL, NULL, NULL, NULL, 'incomplete')`,
  );
  return `INSERT INTO worker_documents (worker_id, resume_cv_url, identity_document_url, criminal_record_url, at_certificate_url, documents_status) VALUES\n${rows.join(',\n')};\n`;
}

function toWorker(s: WorkerSpec, points: Map<string, { lat: number; lng: number }>): InvitarWorker {
  const p = points.get(s.id) ?? null;
  return {
    workerId: s.id,
    name: `${s.name[0]} ${s.name[1]}`,
    index: s.index,
    distKm: s.distKm,
    lat: p?.lat ?? null,
    lng: p?.lng ?? null,
    docsComplete: s.docsComplete,
    band: s.distKm === null ? -1 : bandOf(s.distKm),
  };
}

function seedVacancy(opts: { lat: number | null; lng: number | null; caseNumber: number; professions: string[]; sex: 'F' | 'M'; label: string }): InvitarVacancy {
  const { patientId, addressId } = insertTestPatient({
    withAddress: true,
    firstName: 'Paciente',
    lastName: `QA089-${Date.now()}`,
    addressLat: opts.lat ?? SERVICE_LAT,
    addressLng: opts.lng ?? SERVICE_LNG,
  });
  if (!addressId) throw new Error('seedInvitar089: insertTestPatient não devolveu addressId');
  const coords = opts.lat === null || opts.lng === null ? 'lat = NULL, lng = NULL' : `lat = ${opts.lat}, lng = ${opts.lng}`;
  runSQL(`UPDATE patient_addresses SET address_formatted = '${opts.label}', address_raw = '${opts.label}', ${coords} WHERE id = '${addressId}'`);
  const vacancyId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId,
    caseNumber: opts.caseNumber,
    requiredProfessions: opts.professions,
    requiredSex: opts.sex,
    status: 'SEARCHING',
    isDraft: false,
  });
  return { vacancyId, patientId, addressId, caseNumber: opts.caseNumber };
}

/** Pendente "ya en la vacante": INVITED/manual, sem `messaged_at` (F19). */
function pendingWjaSql(workerId: string, vacancyId: string): string {
  return `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ('${workerId}', '${vacancyId}', 'INVITED', 'manual');\n`;
}

export function seedInvitar089(): Invitar089Seed {
  seedVacancyMatchTemplates();
  const runTag = String(Date.now() % 10000).padStart(4, '0');

  const vacancyA = seedVacancy({ lat: SERVICE_LAT, lng: SERVICE_LNG, caseNumber: 817, professions: ['AT'], sex: 'F', label: SERVICE_LABEL });
  // F6-a: serviço sem coordenada. F6-b: serviço longe de todos, exigindo profissão/sexo que ninguém do seed tem.
  const vacancyB = seedVacancy({ lat: null, lng: null, caseNumber: 818, professions: ['AT'], sex: 'F', label: 'Calle Sin Coordenada 100, QA' });
  const vacancyCBase = seedVacancy({ lat: FAR_LAT, lng: FAR_LNG, caseNumber: 819, professions: ['NURSE'], sex: 'M', label: 'Calle Remota 100, Ushuaia QA' });

  const mk = (id: string, name: [string, string], index: number, distKm: number | null, bearing: number, docsComplete: boolean): WorkerSpec =>
    ({ id, name, index, distKm, bearing, docsComplete, originLat: SERVICE_LAT, originLng: SERVICE_LNG });

  const candidateSpecs = CANVAS_DIST_KM.map((d, i) =>
    mk(randomUUID(), ['Prestadora', `QA ${String(i + 1).padStart(2, '0')}`], i, d, (i * 137.508) % 360, i % 3 !== 2),
  );
  // `PEND` do canvas (`:337-341`): Rosa 23,4 km docs ok · Carla 61,0 km faltan · Nadia sem ubicación docs ok.
  const pendingSpecs = [
    mk(randomUUID(), ['Prestadora', 'QA Vacante 01'], -1, 23.4, (0.9 * 180) / Math.PI, true),
    mk(randomUUID(), ['Prestadora', 'QA Vacante 02'], -1, 61.0, (2.5 * 180) / Math.PI, false),
    mk(randomUUID(), ['Prestadora', 'QA Vacante 03'], -1, null, 0, true),
  ];
  const noAreaSpecs = [
    mk(randomUUID(), ['Prestadora', 'QA SinUbic 01'], -1, null, 0, true),
    mk(randomUUID(), ['Prestadora', 'QA SinUbic 02'], -1, null, 0, false),
  ];
  const all = [...candidateSpecs, ...pendingSpecs, ...noAreaSpecs];

  const areas = areasInsertSql(all);
  const preInvitedSql = PRE_INVITED_INDEXES.map(
    (i) => `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, messaged_at) VALUES ('${candidateSpecs[i].id}', '${vacancyA.vacancyId}', 'INVITED', 'system', ${PRE_INVITED_AT});\n`,
  ).join('');
  const sql =
    workersInsertSql(all, runTag) +
    areas.sql +
    documentsInsertSql(all) +
    preInvitedSql +
    pendingSpecs.map((s) => pendingWjaSql(s.id, vacancyA.vacancyId)).join('') +
    noAreaSpecs.map((s) => pendingWjaSql(s.id, vacancyCBase.vacancyId)).join('');
  psqlBatch(sql);

  const candidates = candidateSpecs.map((s) => toWorker(s, areas.points));
  const seed: Invitar089Seed = {
    vacancyA: { ...vacancyA, serviceLat: SERVICE_LAT, serviceLng: SERVICE_LNG },
    candidates,
    preInvited: PRE_INVITED_INDEXES.map((i) => candidates[i]),
    pending: pendingSpecs.map((s) => toWorker(s, areas.points)),
    vacancyB,
    vacancyC: { ...vacancyCBase, pendingNoArea: noAreaSpecs.map((s) => toWorker(s, areas.points)) },
    cleanup: () => cleanupInvitar089Ids(all.map((s) => s.id), [vacancyA, vacancyB, vacancyCBase]),
  };
  return seed;
}

/** Remove tudo que o seed e o match/envio deixaram: cada DELETE roda sozinho (a falha de um não esconde os seguintes). */
function cleanupInvitar089Ids(workerIds: string[], vacancies: InvitarVacancy[]): void {
  const ids = workerIds.map((w) => `'${w}'`).join(',');
  const jobs = vacancies.map((v) => `'${v.vacancyId}'`).join(',');
  const stmts = [
    `DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id IN (${ids})`,
    `DELETE FROM worker_message_audit WHERE worker_id IN (${ids})`,
    `DELETE FROM messaging_outbox WHERE worker_id IN (${ids})`,
    `DELETE FROM encuadres WHERE job_posting_id IN (${jobs})`,
    `DELETE FROM worker_job_applications WHERE job_posting_id IN (${jobs})`,
    `DELETE FROM worker_documents WHERE worker_id IN (${ids})`,
    `DELETE FROM worker_service_areas WHERE worker_id IN (${ids})`,
    `DELETE FROM workers WHERE id IN (${ids})`,
  ];
  for (const stmt of stmts) {
    try {
      runSQL(stmt);
    } catch (err) {
      console.error(`[cleanup 089] falhou (seguindo): ${stmt.slice(0, 60)}… ${(err as Error).message.split('\n')[0]}`);
    }
  }
  for (const v of vacancies) {
    try {
      cleanupTestPatient(v.patientId);
    } catch (err) {
      console.error(`[cleanup 089] paciente falhou (seguindo): ${(err as Error).message.split('\n')[0]}`);
    }
  }
}

// ── Casos alternativos da §9.8 ─────────────────────────────────────────────────────────────────

/**
 * Alternativo "servidor recusa": grava um despacho `sent` de `daysAgo` dias atrás para o worker → o guard em modo
 * `invite` (`VacancyInviteGuard.ts:100-116`) responde 422 `COOLDOWN` (qualquer envio nos últimos 3 dias).
 */
export function seedCooldownDispatch(workerId: string, vacancyId: string, daysAgo = 1): void {
  runSQL(
    `INSERT INTO whatsapp_bulk_dispatch_logs (worker_id, job_posting_id, triggered_by, phone, template_slug, status, source, dispatched_at) ` +
      `VALUES ('${workerId}', '${vacancyId}', 'admin:e2e-089-seed', NULL, 'ar_vacancy_match_complete', 'sent', 'individual', now() - interval '${daysAgo} day')`,
  );
}

/**
 * Alternativo "estado muda por fora": convida alguém por POST direto da API (a mesma rota da tela, pelo stub 9911) enquanto
 * a página está aberta. `resend` só para quem já tem `messaged_at`.
 */
export async function inviteViaApi(
  request: APIRequestContext,
  user: MockUser,
  workerId: string,
  vacancyId: string,
  opts: { resend?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await request.post(`${BACKEND_URL}/api/admin/messaging/whatsapp/vacancy-match`, {
    headers: { Authorization: `Bearer ${tokenFor(user)}` },
    data: { workerId, jobPostingId: vacancyId, ...(opts.resend ? { resend: true } : {}) },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

// ── Leituras do banco e do stub ────────────────────────────────────────────────────────────────

/** `SELECT count(*) … messaged_at IS NOT NULL` da vacante (CA-11). */
export function countMessagedAt(vacancyId: string): number {
  return Number(runSQL(`SELECT count(*) FROM worker_job_applications WHERE job_posting_id = '${vacancyId}' AND messaged_at IS NOT NULL`));
}

/** `messaged_at` de UM prestador na vacante, ISO ou `null`. */
export function readMessagedAt(workerId: string, vacancyId: string): string | null {
  const out = runSQL(`SELECT messaged_at FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`);
  return out === '' ? null : out;
}

/** Quantos `POST …/message/send` o stub recebeu (desde `fromIndex`, para medir o DELTA entre ações). */
export function stubSendCount(stub: PeriskopeStub, fromIndex = 0): number {
  return stub.calls.slice(fromIndex).filter((c) => c.path.endsWith('/message/send')).length;
}

/** Destinatários (`chat_id` = telefone sintético + `@c.us`) dos envios recebidos pelo stub, na ordem. */
export function stubRecipients(stub: PeriskopeStub, fromIndex = 0): string[] {
  return stub.calls.slice(fromIndex).map((c) => {
    try {
      return String((JSON.parse(c.body) as { chat_id?: string }).chat_id ?? '');
    } catch {
      return '';
    }
  });
}

/** `chat_id` que o Periskope service monta para o telefone do worker (`PeriskopeMessagingService.chatIdFor`). */
export function chatIdOfWorker(workerId: string): string {
  return `${runSQL(`SELECT phone FROM workers WHERE id = '${workerId}'`).replace(/[^\d]/g, '')}@c.us`;
}
