/**
 * Regras do funil do webhook Talentum que MAIS DE UM chamador precisa (o `ProcessTalentumPrescreening` e o script
 * `reconciliar-talentum-sem-worker`). Uma só implementação: o card espelha o Talentum e o script nunca reinterpreta.
 */
import { normalizePhoneAR } from '@shared/utils/phoneNormalization';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
}

/**
 * Etapa do funil a partir do `subtype` do webhook (+ `statusLabel` no ANALYZED).
 * Migration 230: 'INITIATED' (Talentum) → 'PRE_SCREENING' (canônico). 'ANALYZED' é SENTINELA local (ANALYZED sem
 * label, ou label PENDING): quem consome pula o upsert do WJA. Nunca é persistida em `application_funnel_stage`.
 */
export function deriveFunnelStage(subtype: string, statusLabel?: string | null): string {
  if (subtype === 'ANALYZED' && statusLabel) {
    if (statusLabel === 'PENDING') return 'ANALYZED';
    return statusLabel;
  }
  if (subtype === 'INITIATED') return 'PRE_SCREENING';
  return subtype;
}

/** F3 (mig 191): NOT_QUALIFIED não existe no enum de `application_funnel_stage` — vira REJECTED antes do upsert. */
export function toPersistedFunnelStage(funnelStage: string): string {
  return funnelStage === 'NOT_QUALIFIED' ? 'REJECTED' : funnelStage;
}

/**
 * Transição NOT_QUALIFIED do webhook: encuadre RECHAZADO + WJA REJECTED + eventos AUDIT-ONLY (nascem `processed`:
 * sem consumidor, portanto sem mensagem). `funnelStage` é o ORIGINAL (NOT_QUALIFIED) para identificar a transição;
 * `previousStage` = etapa do WJA antes do upsert (já REJECTED → não repete).
 */
export async function applyNotQualifiedTransition(
  client: Queryable, workerId: string, jobPostingId: string, funnelStage: string, previousStage: string | null,
  prescreeningId?: string,
): Promise<boolean> {
  if (funnelStage !== 'NOT_QUALIFIED' || previousStage === 'REJECTED') return false;

  await client.query(
    `UPDATE encuadres
     SET resultado = 'RECHAZADO', rejection_reason_category = 'TALENTUM_NOT_QUALIFIED', updated_at = NOW()
     WHERE worker_id = $1 AND job_posting_id = $2 AND resultado IS NULL`,
    [workerId, jobPostingId],
  );
  await client.query(
    `INSERT INTO domain_events (event, payload, status, processed_at) VALUES ('funnel_stage.not_qualified', $1::jsonb, 'processed', NOW())`,
    [JSON.stringify({ workerId, jobPostingId })],
  );
  await client.query(
    `UPDATE worker_job_applications
     SET application_funnel_stage = 'REJECTED', updated_at = NOW()
     WHERE worker_id = $1 AND job_posting_id = $2`,
    [workerId, jobPostingId],
  );
  await client.query(
    `INSERT INTO domain_events (event, payload, status, processed_at) VALUES ('funnel_stage.rejected', $1::jsonb, 'processed', NOW())`,
    [JSON.stringify({ workerId, jobPostingId, prescreeningId: prescreeningId ?? null, source: 'auto_not_qualified' })],
  );
  return true;
}

export type InsertTalentumWorkerResult =
  | { kind: 'CREATED'; id: string }
  | { kind: 'COLLISION' }
  | { kind: 'ERROR'; message: string };

/**
 * Auto-create do worker do webhook (INSERT INCOMPLETE_REGISTER, auth_uid sintético `talentum_<profileId>`).
 * 23505 → COLLISION (o chamador decide: o webhook resolve o dono existente; o script lista e não insiste).
 * Qualquer outra falha → ERROR com a mensagem (sem `detail`, que ecoa a linha).
 */
export async function insertTalentumWorker(
  db: Queryable, profile: { id: string; email: string; phoneNumber: string },
): Promise<InsertTalentumWorkerResult> {
  const phone = normalizePhoneAR(profile.phoneNumber) || null;
  const authUid = `talentum_${profile.id}`;
  try {
    const result = await db.query(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR')
       RETURNING id`,
      [authUid, profile.email, phone],
    );
    return { kind: 'CREATED', id: result.rows[0].id };
  } catch (err: unknown) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code === '23505') return { kind: 'COLLISION' };
    return { kind: 'ERROR', message: pgErr.message ?? String(err) };
  }
}
