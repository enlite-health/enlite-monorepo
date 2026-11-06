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

const ANALYZED_LABELS: readonly string[] = ['QUALIFIED', 'NOT_QUALIFIED', 'IN_DOUBT', 'PENDING'];

/**
 * Etapa do funil a partir do `talentum_prescreenings.status` JÁ GRAVADO (scripts de correção de dado). O webhook grava o
 * `statusLabel` no lugar de 'ANALYZED'; um 'ANALYZED' cru (sem label) NUNCA vai para o WJA (violaria o CHECK de
 * `application_funnel_stage`): usa-se o `label` informado pelo chamador (do Talentum); sem label → `null`.
 * `null` também para a sentinela do webhook (PENDING). Devolve a etapa ORIGINAL (NOT_QUALIFIED não é convertida aqui:
 * use `toPersistedFunnelStage` ao gravar).
 */
export function funnelStageFromStoredStatus(status: string, label?: string | null): string | null {
  const derived = status === 'ANALYZED'
    ? deriveFunnelStage('ANALYZED', label && ANALYZED_LABELS.includes(label) ? label : null)
    : ANALYZED_LABELS.includes(status)
      ? deriveFunnelStage('ANALYZED', status)
      : deriveFunnelStage(status);
  return derived === 'ANALYZED' ? null : derived;
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
  // F3: etapa humana ACIMA de QUALIFIED (CONFIRMED/SELECTED/QRT) fica com a operação — o card mostra o veredito
  // (talentum_prescreenings), mas WJA e encuadre não mudam e não nasce o evento auto_not_qualified. Fonte única da
  // ordem: `funnel_stage_precedence` (mig 477), a mesma do upsert; etapa desconhecida (-1) segue rebaixando como antes.
  if (previousStage !== null) {
    const above = await client.query(
      `SELECT funnel_stage_precedence($1) > funnel_stage_precedence('QUALIFIED') AS above`, [previousStage],
    );
    if (above.rows[0]?.above === true) return false;
  }

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

/** Vereditos positivos do Talentum que o card espelha (os dois têm etapa própria no funil). */
const POSITIVE_VERDICT_STAGES: readonly string[] = ['QUALIFIED', 'IN_DOUBT'];

/** Ator automático da trilha: vazio/NULL (webhook) ou `system:<nome>` (script). uid humano = nunca automático. */
const isAutomaticActor = (changedBy: string | null | undefined): boolean => {
  const by = changedBy ?? '';
  return by === '' || by.startsWith('system:');
};

/**
 * Caminho inverso de `applyNotQualifiedTransition`: o Talentum é a fonte da verdade do card, então um veredito
 * POSITIVO (QUALIFIED/IN_DOUBT) que chega para uma candidatura cujo REJECTED veio da rejeição AUTOMÁTICA do próprio
 * Talentum desfaz essa rejeição. O upsert do WJA ("etapa não regride", `funnel_stage_precedence`: REJECTED=7 > QUALIFIED=5)
 * deixaria o card preso em Rechazados.
 *
 * "Automática" = as DUAS provas, lidas do que já está gravado (sem migration):
 *  1. a ÚLTIMA linha da trilha `worker_job_application_stage_history` é um REJECTED com `changed_by` vazio ou `system:<nome>` (script) — o gatilho
 *     (mig 478) grava `app.current_uid`; o webhook roda fora de `withActorContext`, então NULL/''; "Mover a…" humano
 *     grava o uid de quem moveu, e qualquer movimento humano posterior vira a última linha (a rejeição humana NUNCA é revertida);
 *  2. existe o evento `funnel_stage.rejected` com `source = 'auto_not_qualified'` (gravado por `applyNotQualifiedTransition`).
 * Sem as duas, não toca em nada. O encuadre só perde o resultado se ainda for o RECHAZADO/TALENTUM_NOT_QUALIFIED que a
 * rejeição automática pôs. Evento de auditoria nasce `processed` (sem consumidor: nenhuma mensagem ao prestador).
 * Chamar DEPOIS do upsert do WJA, com a `previousStage` que ele devolveu, na mesma transação.
 */
export async function revertAutoRejectionOnPositiveVerdict(
  client: Queryable, workerId: string, jobPostingId: string, funnelStage: string, previousStage: string | null,
  prescreeningId?: string,
): Promise<boolean> {
  if (previousStage !== 'REJECTED' || !POSITIVE_VERDICT_STAGES.includes(funnelStage)) return false;

  const last = await client.query(
    `SELECT h.new_value, h.changed_by
       FROM worker_job_application_stage_history h
       JOIN worker_job_applications a ON a.id = h.application_id
      WHERE a.worker_id = $1 AND a.job_posting_id = $2 AND h.field_name = 'application_funnel_stage'
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT 1`,
    [workerId, jobPostingId],
  );
  const row = last.rows[0];
  if (!row || row.new_value !== 'REJECTED' || !isAutomaticActor(row.changed_by)) return false;

  const auto = await client.query(
    `SELECT 1 FROM domain_events
      WHERE event = 'funnel_stage.rejected'
        AND payload->>'workerId' = $1 AND payload->>'jobPostingId' = $2
        AND payload->>'source' = 'auto_not_qualified'
      LIMIT 1`,
    [workerId, jobPostingId],
  );
  if (auto.rows.length === 0) return false;

  await client.query(
    `UPDATE worker_job_applications
        SET application_funnel_stage = $3, updated_at = NOW()
      WHERE worker_id = $1 AND job_posting_id = $2 AND application_funnel_stage = 'REJECTED'`,
    [workerId, jobPostingId, funnelStage],
  );
  await client.query(
    `UPDATE encuadres
        SET resultado = NULL, rejection_reason_category = NULL, updated_at = NOW()
      WHERE worker_id = $1 AND job_posting_id = $2
        AND resultado = 'RECHAZADO' AND rejection_reason_category = 'TALENTUM_NOT_QUALIFIED'`,
    [workerId, jobPostingId],
  );
  await client.query(
    `INSERT INTO domain_events (event, payload, status, processed_at) VALUES ('funnel_stage.rejection_reverted', $1::jsonb, 'processed', NOW())`,
    [JSON.stringify({ workerId, jobPostingId, prescreeningId: prescreeningId ?? null, toStage: funnelStage, source: 'talentum' })],
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
 * Qualquer outra falha → ERROR com a causa SEM PII (code/constraint do pg, ou a mensagem de erro nosso).
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
    const pgErr = err as { code?: string; message?: string; constraint?: string };
    if (pgErr.code === '23505') return { kind: 'COLLISION' };
    // Erro do pg: só code/constraint (a mensagem pode ecoar valor). Erro nosso: a mensagem.
    const cause = pgErr.code
      ? [`code=${pgErr.code}`, pgErr.constraint ? `constraint=${pgErr.constraint}` : null].filter(Boolean).join(' ')
      : (pgErr.message ?? String(err)).split('\n')[0];
    return { kind: 'ERROR', message: cause };
  }
}
