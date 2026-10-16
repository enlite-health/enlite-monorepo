import { PAID_REHEARSAL_RELEASED_EVENT, SKIPPED_TEST_EVENT, type SkippedTestStage } from '../domain/admissionRealm';

/**
 * SQL do "ensaio pago" (spec 050 F3, R-19) — UM lugar para as consultas que leem a liberação, para que fila, serviço e
 * conteúdo da mensagem não reescrevam o mesmo conceito. A trilha é só-acréscimo: liberar e expirar nunca apagam evento.
 *
 * `alias` é o alias SQL de `admission_appointments` na consulta que usa o fragmento (valor fixo do código, nunca entrada).
 */

/** Fim da liberação MAIS RECENTE da reunião (NULL = nunca liberada). Entrada de `admissionRealm({ rehearsalUntil })`. */
export const rehearsalUntilSql = (alias: string): string =>
  `(SELECT max((r.ref->>'expiresAt')::timestamptz) FROM admission_events r
     WHERE r.appointment_id = ${alias}.id AND r.kind = '${PAID_REHEARSAL_RELEASED_EVENT}')`;

/**
 * Existe um `skipped_test` desta etapa SEM liberação mais nova depois dele? Se sim, a reunião está fora da fila.
 *  - `skipped_test` → liberação → a reunião volta à fila (o `skipped_test` antigo já não vale);
 *  - liberação → expirou → o job grava um `skipped_test` NOVO (mais recente que a liberação) → fora da fila de novo.
 * Sem apagar nada e sem laço: cada expiração custa exatamente um evento.
 */
export const standingSkippedTestSql = (alias: string, stage: SkippedTestStage): string =>
  `EXISTS (SELECT 1 FROM admission_events s
            WHERE s.appointment_id = ${alias}.id AND s.kind = '${SKIPPED_TEST_EVENT}' AND s.reason = '${stage}'
              AND NOT EXISTS (SELECT 1 FROM admission_events r
                               WHERE r.appointment_id = s.appointment_id AND r.kind = '${PAID_REHEARSAL_RELEASED_EVENT}' AND r.at > s.at))`;
