/**
 * scheduleOpportunisticOrphanRetry — achado da revisão do PR-4 (item 3): antes desta rodada,
 * NADA chamava `PatientPhotoOrphanRetryService` — a fila `patient_photo_orphans` só crescia,
 * nunca esvaziava sozinha. O padrão da casa para job interno é HTTP protegido por
 * `internalAuthMiddleware`, disparado por Cloud Scheduler (`internalRoutes.ts` — `/outbox/sweep`,
 * `/reminders/sweep` etc.), mas a `stage` NÃO roda Cloud Scheduler (`dupla-de-pr-stage-e-prd.md`) —
 * um endpoint que só o Scheduler chama nunca rodaria lá. Por isso o retry aqui é OPORTUNISTA: uma
 * tentativa pequena e best-effort, disparada no caminho feliz de upload/delete/revoke/purge (os
 * mesmos pontos que ALIMENTAM a fila), sem bloquear a resposta ao cliente e sem propagar falha.
 *
 * NÃO substitui um job agendado em PRD (Cloud Scheduler continua sendo o caminho de cobertura
 * garantida lá) — é o que faz a fila andar sozinha onde não há Scheduler, e reduz o atraso onde há.
 */
import { logger } from '@shared/logging';
import { safeStorageErrorFields } from '../infrastructure/safeStorageErrorFields';
import { PatientPhotoOrphanRetryService } from './PatientPhotoOrphanRetryService';

/** Poucos itens por disparo — best-effort, não um worker de fila completo. */
const OPPORTUNISTIC_RETRY_LIMIT = 3;

/**
 * Fire-and-forget: NUNCA lança, NUNCA atrasa quem chamou (não é `await`ado pelo caller). Falha
 * apenas loga (sem PII — só o `err` e a contagem já tratados dentro do próprio retry service).
 */
export function scheduleOpportunisticOrphanRetry(
  retryService: PatientPhotoOrphanRetryService = new PatientPhotoOrphanRetryService(),
): void {
  retryService.retryOnce(OPPORTUNISTIC_RETRY_LIMIT).catch((err) => {
    logger.warn(safeStorageErrorFields(err), '[scheduleOpportunisticOrphanRetry] tentativa oportunista falhou — segue para o próximo gatilho');
  });
}
