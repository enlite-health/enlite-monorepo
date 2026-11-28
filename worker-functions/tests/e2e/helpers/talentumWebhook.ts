/**
 * talentumWebhook.ts — helper dos e2e do webhook do Talentum depois do ack assíncrono (spec 095 §3.2, T-095-24).
 *
 * O webhook só guarda o corpo na inbox e responde `200 { received: true }`; quem grava o espelho, o worker, o card e a
 * vaga é o processador. Então todo e2e que afirma algo no banco logo depois do POST precisa DRENAR a inbox antes, e ler
 * do banco (o corpo do ack não traz mais ids).
 *
 *  - `PRESCREENING_RESPONSE`: drena por `POST /api/internal/talentum/inbox/redrive { talentumPrescreeningId, talentumProfileId }`
 *    (chave do payload: `data.prescreening.id` + `data.profile.id`).
 *  - `PRESCREENING` (criação de vaga, chave = `data._id`, profile NULO): o redrive por chave EXIGE os dois ids
 *    (`parseRedriveBody` devolve 400 com profile vazio) e o por estado (`RECEIVED`) varreria linhas de OUTROS testes
 *    rodando em paralelo (o `talentum-inbox-ack` afirma RECEIVED). Por isso aqui se acha o `id` da linha da inbox pela chave
 *    e se chama `POST /api/internal/talentum/inbox/process` (o push do Pub/Sub, 1 linha só).
 *
 * Antes do POST, apaga da inbox a linha de MESMO `body_hash` (a inbox deduplica corpo idêntico: sem isto, reexecutar o teste
 * no mesmo banco, ou mandar o mesmo evento 2x de propósito, não geraria nada para drenar — antes o caso de uso rodava de novo).
 *
 * Convenção dos helpers irmãos: env lida DENTRO das funções, nunca `throw` no import; fallbacks iguais aos do CI.
 */
import type { AxiosInstance } from 'axios';
import { Pool } from 'pg';
import { computeBodyHash } from '../../../src/modules/integration/domain/TalentumInbox';

export const TALENTUM_WEBHOOK = '/api/webhooks/talentum/prescreening';
export const TALENTUM_WEBHOOK_TEST = '/api/webhooks-test/talentum/prescreening';
const REDRIVE = '/api/internal/talentum/inbox/redrive';
const PROCESS = '/api/internal/talentum/inbox/process';

export interface TalentumDrain {
  status: number;
  selected: number;
  processed: number;
  failed: number;
}

export interface TalentumAckAndDrain {
  /** Status e corpo do ack do webhook (`200 { received: true }`, ou o 400 mínimo). */
  ack: { status: number; data: any };
  /** Contagens do drain; `null` quando não havia o que drenar (ack ≠ 200 ou action sem chave). */
  drain: TalentumDrain | null;
}

const internalHeaders = () => ({ 'X-Internal-Secret': process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only' });

const databaseUrl = () =>
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

type Key = { action: string; prescreeningId: string; profileId: string | null } | null;

/** Chave de drenagem do payload (a mesma que o ack grava na inbox). */
export function talentumKeyOf(payload: unknown): Key {
  const b = payload as Record<string, any> | null | undefined;
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (b?.action === 'PRESCREENING_RESPONSE') {
    const p = b?.data?.prescreening?.id;
    const f = b?.data?.profile?.id;
    return nonEmpty(p) && nonEmpty(f) ? { action: b.action, prescreeningId: p, profileId: f } : null;
  }
  if (b?.action === 'PRESCREENING') {
    const p = b?.data?._id;
    return nonEmpty(p) ? { action: b.action, prescreeningId: p, profileId: null } : null;
  }
  return null;
}

/** Drena a(s) linha(s) da inbox desse payload. Só contagens; nenhum corpo é lido ou logado. */
export async function drainTalentumInbox(api: AxiosInstance, payload: unknown): Promise<TalentumDrain | null> {
  const key = talentumKeyOf(payload);
  if (!key) return null;

  if (key.profileId !== null) {
    const res = await api.post(
      REDRIVE,
      { talentumPrescreeningId: key.prescreeningId, talentumProfileId: key.profileId },
      { headers: internalHeaders() },
    );
    return { status: res.status, ...(res.data as { selected: number; processed: number; failed: number }) };
  }

  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM talentum_webhook_inbox
        WHERE talentum_prescreening_id = $1 AND action = $2 AND state <> 'PROCESSED'
        ORDER BY received_at, id`,
      [key.prescreeningId, key.action],
    );
    let processed = 0;
    let failed = 0;
    let status = 200;
    for (const r of rows) {
      const data = Buffer.from(JSON.stringify({ inboxId: r.id })).toString('base64');
      const res = await api.post(PROCESS, { message: { data, messageId: '1' }, subscription: 'sub' }, { headers: internalHeaders() });
      status = res.status;
      if (res.status === 200) processed += (res.data as { processed: number }).processed;
      else failed += 1;
    }
    return { status, selected: rows.length, processed, failed };
  } finally {
    await pool.end();
  }
}

/** Apaga da inbox a linha de mesmo corpo (dedupe por `body_hash`), para o POST gerar uma linha nova a drenar. */
export async function forgetTalentumInboxBody(payload: unknown): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  try {
    await pool.query(`DELETE FROM talentum_webhook_inbox WHERE body_hash = $1`, [computeBodyHash(payload)]);
  } finally {
    await pool.end();
  }
}

/**
 * POST no webhook e depois drena a inbox pela chave do payload. Devolve `{ ack, drain }`.
 * `api` é o cliente axios dos e2e (`createApiClient()`, `validateStatus: () => true`).
 */
export async function postTalentumAndDrain(
  api: AxiosInstance,
  payload: unknown,
  endpoint: string = TALENTUM_WEBHOOK,
): Promise<TalentumAckAndDrain> {
  await forgetTalentumInboxBody(payload);
  const res = await api.post(endpoint, payload);
  const ack = { status: res.status, data: res.data };
  const drain = res.status === 200 ? await drainTalentumInbox(api, payload) : null;
  return { ack, drain };
}

/** O que o ack deixou de devolver: o espelho gravado pelo processador, lido do banco pela chave externa. `null` = não gravou. */
export async function readTalentumMirror(
  pool: Pick<Pool, 'query'>,
  talentumPrescreeningId: string,
): Promise<{ prescreeningId: string; talentumPrescreeningId: string; workerId: string | null; jobPostingId: string | null } | null> {
  const { rows } = await pool.query<{ id: string; worker_id: string | null; job_posting_id: string | null }>(
    `SELECT id, worker_id, job_posting_id FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`,
    [talentumPrescreeningId],
  );
  if (rows.length === 0) return null;
  return { prescreeningId: rows[0].id, talentumPrescreeningId, workerId: rows[0].worker_id, jobPostingId: rows[0].job_posting_id };
}

export interface TalentumPostRead extends TalentumAckAndDrain {
  /** Status do ack (atalho de `ack.status`). */
  status: number;
  /**
   * Com ack 200 de `PRESCREENING_RESPONSE`: o espelho gravado pelo processador, lido do BANCO
   * (`prescreeningId`, `talentumPrescreeningId`, `workerId`, `jobPostingId`, `resolved.{worker,jobPosting}`).
   * Fora disso (ack 400, ou action sem espelho): o corpo do ack.
   */
  data: any;
}

/** `postTalentumAndDrain` + a leitura do espelho no banco: para os testes que liam ids do corpo da resposta (hoje `{ received: true }`). */
export async function postTalentumDrainAndRead(
  api: AxiosInstance,
  pool: Pick<Pool, 'query'>,
  payload: unknown,
  endpoint: string = TALENTUM_WEBHOOK,
): Promise<TalentumPostRead> {
  const r = await postTalentumAndDrain(api, payload, endpoint);
  const psc = (payload as any)?.data?.prescreening?.id;
  const m = r.ack.status === 200 && typeof psc === 'string' ? await readTalentumMirror(pool, psc) : null;
  return {
    ...r,
    status: r.ack.status,
    data: m ? { ...m, resolved: { worker: m.workerId !== null, jobPosting: m.jobPostingId !== null } } : r.ack.data,
  };
}
