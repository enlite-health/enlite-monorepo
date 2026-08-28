import { Pool } from 'pg';

const SLUG_COMPLETE   = 'ar_vacancy_match_complete';
const SLUG_INCOMPLETE = 'ar_vacancy_match_incomplete';

// Threshold de convites sem-resposta antes de pausar o envio manual.
// Configurável por env; pausa reversível (NÃO é opt-out permanente).
const MAX_UNANSWERED = Number(process.env.MANUAL_INVITE_MAX_UNANSWERED ?? 3);

// Janela mínima entre dois REENVIOS manuais para a mesma pessoa na mesma vaga
// (botão "Reenviar" da tarjeta — planning 26/08, REQ-08). Horas, configurável.
const RESEND_COOLDOWN_HOURS = Number(process.env.MANUAL_RESEND_COOLDOWN_HOURS ?? 24);

export type VacancyInviteMode = 'invite' | 'resend';

export interface VacancyInviteGuardOptions {
  /**
   * `invite` (default): as 4 travas do disparo manual.
   * `resend`: reenvio EXPLÍCITO pela recrutadora (botão na tarjeta). Mantém
   * opt-out e o throttle de não-resposta; troca o cooldown global de 3 dias e a
   * idempotência de 7 dias — que por definição negariam todo reenvio — por um
   * cooldown de RESEND_COOLDOWN_HOURS entre reenvios ao mesmo worker×vaga.
   */
  mode?: VacancyInviteMode;
}

export type VacancyInviteGuardResult =
  | { allowed: true }
  | { allowed: false; code: string; detail: string };

/**
 * Guard reutilizável para o disparo INDIVIDUAL MANUAL de convite de vaga.
 *
 * Espelha as travas do VacancyAutoInviteHandler (opt-out, cooldown 3d,
 * idempotência 7d) e adiciona um throttle suave de não-resposta que protege
 * o score de qualidade do WhatsApp/Meta.
 *
 * Roda os 4 checks EM ORDEM. No primeiro que bloquear, retorna
 * { allowed:false, code, detail }. Passando em todos, { allowed:true }.
 */
export async function assertVacancyInviteAllowed(
  db: Pool,
  workerId: string,
  jobPostingId: string,
  options: VacancyInviteGuardOptions = {},
): Promise<VacancyInviteGuardResult> {
  const mode: VacancyInviteMode = options.mode ?? 'invite';
  // Check 1 — opt-out: worker pediu pra não receber mensagens
  const optOutRes = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM messaging_opt_out
      WHERE worker_id = $1 AND opted_in_at IS NULL
    ) AS exists`,
    [workerId],
  );
  if (optOutRes.rows[0]?.exists) {
    return {
      allowed: false,
      code: 'OPTED_OUT',
      detail: 'Worker pediu para não receber mensagens (opt-out).',
    };
  }

  if (mode === 'resend') {
    // Reenvio explícito: só a janela entre reenvios ao MESMO worker×vaga.
    const resendRes = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM whatsapp_bulk_dispatch_logs
        WHERE worker_id = $1
          AND job_posting_id = $2
          AND status = 'sent'
          AND dispatched_at > NOW() - ($3 * INTERVAL '1 hour')
      ) AS exists`,
      [workerId, jobPostingId, RESEND_COOLDOWN_HOURS],
    );
    if (resendRes.rows[0]?.exists) {
      return {
        allowed: false,
        code: 'RESEND_COOLDOWN',
        detail: `Já houve um envio para esta pessoa nesta vaga nas últimas ${RESEND_COOLDOWN_HOURS} horas.`,
      };
    }
    return assertNotThrottled(db, workerId);
  }

  // Check 2 — cooldown global: worker recebeu qualquer msg nos últimos 3 dias
  const cooldownRes = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM whatsapp_bulk_dispatch_logs
      WHERE worker_id = $1
        AND status = 'sent'
        AND dispatched_at > NOW() - INTERVAL '3 days'
    ) AS exists`,
    [workerId],
  );
  if (cooldownRes.rows[0]?.exists) {
    return {
      allowed: false,
      code: 'COOLDOWN',
      detail: 'Worker recebeu uma mensagem nos últimos 3 dias.',
    };
  }

  // Check 3 — idempotência 7d (mesma vaga): checa DUAS fontes, porque o manual
  // loga em whatsapp_bulk_dispatch_logs e o auto insere em messaging_outbox
  const idempotencyRes = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM whatsapp_bulk_dispatch_logs
      WHERE worker_id = $1
        AND job_posting_id = $2
        AND status = 'sent'
        AND dispatched_at > NOW() - INTERVAL '7 days'
      UNION ALL
      SELECT 1 FROM messaging_outbox
      WHERE worker_id = $1
        AND job_posting_id = $2
        AND template_slug IN ('${SLUG_COMPLETE}', '${SLUG_INCOMPLETE}')
        AND status IN ('pending', 'sent')
        AND created_at > NOW() - INTERVAL '7 days'
    ) AS exists`,
    [workerId, jobPostingId],
  );
  if (idempotencyRes.rows[0]?.exists) {
    return {
      allowed: false,
      code: 'ALREADY_INVITED',
      detail: 'Worker já foi convidado para esta vaga nos últimos 7 dias.',
    };
  }

  return assertNotThrottled(db, workerId);
}

/**
 * Check 4 — throttle suave de não-resposta (o que protege o score):
 * pausa reversível se o worker já acumulou convites de vaga sem NUNCA
 * responder (nenhuma candidatura saiu de INVITED). NÃO escreve opt-out,
 * NÃO é bloqueio permanente — só barra o envio agora. Vale para convite E reenvio.
 */
async function assertNotThrottled(db: Pool, workerId: string): Promise<VacancyInviteGuardResult> {
  const unansweredRes = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM whatsapp_bulk_dispatch_logs
     WHERE worker_id = $1
       AND status = 'sent'
       AND template_slug IN ('${SLUG_COMPLETE}', '${SLUG_INCOMPLETE}')`,
    [workerId],
  );
  const unansweredInvites = unansweredRes.rows[0]?.n ?? 0;

  const engagedRes = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM worker_job_applications
      WHERE worker_id = $1
        AND application_funnel_stage <> 'INVITED'
    ) AS exists`,
    [workerId],
  );
  const hasEngaged = engagedRes.rows[0]?.exists === true;

  if (unansweredInvites >= MAX_UNANSWERED && !hasEngaged) {
    return {
      allowed: false,
      code: 'UNANSWERED_THROTTLE',
      detail: `Worker já recebeu ${unansweredInvites} convites de vaga sem nunca responder (nenhuma candidatura avançou de INVITED). Envio pausado até engajar.`,
    };
  }

  return { allowed: true };
}
