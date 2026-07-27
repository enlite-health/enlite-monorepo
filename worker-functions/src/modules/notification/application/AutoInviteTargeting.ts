import { Pool } from 'pg';

const SLUG_COMPLETE   = 'ar_vacancy_match_complete';
const SLUG_INCOMPLETE = 'ar_vacancy_match_incomplete';

export type AutoInviteTargetResult =
  | { allowed: true }
  | { allowed: false; code: 'NOT_ACTIVE_AND_ALREADY_INVITED'; detail: string };

/**
 * Filtro de ALVO do auto-convite de vaga (aplica-se SÓ ao disparo automático —
 * o disparo individual manual, humano, não passa por aqui).
 *
 * Regra de negócio (produto, 2026-07-27) para conter volume após o incidente de
 * spam de WhatsApp. Só convida o worker que:
 *   - ENGAJOU no funil — tem candidatura que já passou de `INVITED` (respondeu
 *     / avançou em alguma vaga), OU
 *   - ainda NÃO recebeu nenhuma outra vaga (é a primeira vaga da pessoa).
 * Bloqueia quem já recebeu convite de vaga antes E nunca engajou — exatamente o
 * perfil que acumula convites ignorados e gera reclamação de spam.
 *
 * COMPLEMENTA (não substitui) o `assertVacancyInviteAllowed`, que segue rodando
 * opt-out / cooldown 3d / idempotência 7d / throttle de não-resposta. Este filtro
 * é uma trava adicional e mais estrita, só no caminho automático.
 *
 * "Recebeu vaga antes" = recebeu MENSAGEM de convite (bulk logs OU outbox) —
 * não conta o WJA `INVITED`, que o matchmaking cria mesmo sem enviar mensagem.
 *
 * Uma única query (dois EXISTS) para evitar round-trips no loop de candidatos.
 */
export async function assertAutoInviteTargetAllowed(
  db: Pool,
  workerId: string,
): Promise<AutoInviteTargetResult> {
  const { rows } = await db.query<{ engaged: boolean; prior_invite: boolean }>(
    `SELECT
       EXISTS(
         SELECT 1 FROM worker_job_applications
         WHERE worker_id = $1 AND application_funnel_stage <> 'INVITED'
       ) AS engaged,
       EXISTS(
         SELECT 1 FROM whatsapp_bulk_dispatch_logs
         WHERE worker_id = $1
           AND status = 'sent'
           AND template_slug IN ('${SLUG_COMPLETE}', '${SLUG_INCOMPLETE}')
         UNION ALL
         SELECT 1 FROM messaging_outbox
         WHERE worker_id = $1
           AND template_slug IN ('${SLUG_COMPLETE}', '${SLUG_INCOMPLETE}')
           AND status IN ('pending', 'sent')
       ) AS prior_invite`,
    [workerId],
  );

  const engaged     = rows[0]?.engaged === true;
  const priorInvite = rows[0]?.prior_invite === true;

  // Passa se: engajou (ativo) OU nunca recebeu vaga antes (primeira vaga).
  if (engaged || !priorInvite) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: 'NOT_ACTIVE_AND_ALREADY_INVITED',
    detail:
      'Worker não engajou no funil e já recebeu convite de vaga antes — ' +
      'auto-convite controlado só envia para ativos (engajados) ou para a primeira vaga.',
  };
}
