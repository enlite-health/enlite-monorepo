/**
 * blockedAttemptLiveState
 *
 * Fonte única do estado AO VIVO de uma tentativa bloqueada.
 *
 * `worker_blocked_applications` é um snapshot: `blocked_reason` e `missing_fields`
 * são escritos no instante em que o gate barrou a postulação e NUNCA mais são
 * atualizados — só uma nova tentativa os reescreve. A pessoa, porém, muda depois:
 * completa o cadastro, é reativada por atividade (`ReactivateArchivedWorkerUseCase`),
 * é destravada pelo staff. O card seguia exibindo o motivo de meses atrás.
 *
 * Medido em produção em 08/09/2026 (D300): **135 dos 1.271 cards abertos exibiam
 * motivo errado** — 90 deles de pessoas REGISTERED, isto é, elegíveis naquele
 * momento e escondidas atrás de um rótulo velho na única superfície em que
 * aparecem (o `activeWorkerFilter` tira DISABLED de todo o resto do painel).
 *
 * O recálculo on-read já existia, mas pela metade: alcançava só `missing_fields`,
 * e só quando o motivo congelado JÁ era `registration_incomplete` — exatamente o
 * caso em que ele não muda nada. Este módulo fecha o buraco recalculando as duas
 * coisas, nos três caminhos de leitura (`list`, `listByVacancy`, `listByWorker`).
 *
 * ⚠️ A regra aqui é um ESPELHO de `assertWorkerCanApply`
 * (`../domain/WorkerApplicationEligibility.ts`) — mesma ordem, mesmos predicados.
 * Se as duas divergirem, o card volta a mentir, agora ao contrário: promete
 * elegibilidade que o gate nega.
 *
 * 🔒 **O guarda dessa divergência é `tests/e2e/blocked-attempt-live-state.test.ts`,
 * e ele exige BANCO REAL** — roda no job `backend-e2e` (`npm run test:e2e`), NÃO
 * em `npm test`. Medido em 08/09: com o espelho sabotado, a suíte unitária inteira
 * (88 suítes, 1.108 testes) fica VERDE, e o `pre-push` também. Os asserts unitários
 * comparam o SQL com o próprio módulo — são tautológicos por construção e não podem
 * pegar conteúdo errado. Quem mexer em `assertWorkerCanApply` tem de rodar o e2e.
 */

import { DISABLED_WORKER_STATUS } from '@shared/database/activeWorkerFilter';

/** Único status que o gate de postulação aceita. Ver `assertWorkerCanApply`. */
export const ELIGIBLE_WORKER_STATUS = 'REGISTERED';

/**
 * Estado exibível de um card bloqueado.
 *
 * Os três primeiros são os motivos do gate (`WorkerEligibilityReason`). O quarto
 * não existe no gate de propósito: `eligible` é a ausência de motivo — a pessoa
 * passaria hoje, e o card só continua na coluna porque a promoção depende do
 * evento `worker.registration_completed`, que já passou.
 */
export const BLOCKED_ATTEMPT_LIVE_STATES = [
  'worker_not_found',
  'worker_disabled',
  'registration_incomplete',
  'eligible',
] as const;

export type BlockedAttemptLiveState = (typeof BLOCKED_ATTEMPT_LIVE_STATES)[number];

/**
 * JOIN obrigatório para quem usa os fragmentos abaixo.
 *
 * `merged_into_id IS NULL` não é detalhe: `assertWorkerCanApply` filtra por ele,
 * então um ID absorvido num merge é `worker_not_found` para o gate — e tem de ser
 * a mesma coisa aqui. (O acerto de fundo, seguir o merge em vez de perder a
 * pessoa, é a proposta `matching-merge-aware-eligibility`; enquanto ela não entra,
 * espelhar o comportamento vigente é o correto: o card não pode prometer o que o
 * gate recusa.)
 *
 * @param blockedAlias alias de `worker_blocked_applications` na query.
 * @param workerAlias  alias a criar para `workers` (default `lw`, de *live worker*).
 */
export function liveWorkerJoinSql(blockedAlias = 'wba', workerAlias = 'lw'): string {
  return (
    `LEFT JOIN workers ${workerAlias} ` +
    `ON ${workerAlias}.id = ${blockedAlias}.worker_id ` +
    `AND ${workerAlias}.merged_into_id IS NULL`
  );
}

// Predicados atômicos — a ordem de avaliação é a de `assertWorkerCanApply`.
// Motivo e campos faltantes são derivados DESTES, e não escritos duas vezes: é o
// que impede o conserto de nascer já com a mesma divergência que ele corrige.
const notFoundSql = (a: string): string => `${a}.id IS NULL`;
const disabledSql = (a: string): string => `${a}.status = '${DISABLED_WORKER_STATUS}'`;
const notRegisteredSql = (a: string): string => `${a}.status <> '${ELIGIBLE_WORKER_STATUS}'`;

/**
 * Motivo recalculado contra o estado de HOJE, no lugar do snapshot.
 *
 * @param workerAlias alias criado por `liveWorkerJoinSql`.
 */
export function liveBlockedReasonSql(workerAlias = 'lw'): string {
  return (
    `CASE ` +
    `WHEN ${notFoundSql(workerAlias)} THEN 'worker_not_found' ` +
    `WHEN ${disabledSql(workerAlias)} THEN 'worker_disabled' ` +
    `WHEN ${notRegisteredSql(workerAlias)} THEN 'registration_incomplete' ` +
    `ELSE 'eligible' ` +
    `END`
  );
}

/**
 * Campos faltantes, recalculados pela SSOT do banco (`fn_worker_missing_fields`).
 *
 * Vazio quando o motivo vivo não é `registration_incomplete`: não existem "campos
 * faltantes" de quem está desativado, de quem não foi encontrado ou de quem já
 * está completo — e devolver o snapshot nesses casos é reintroduzir a mentira
 * pela porta dos fundos (era assim que o card da Flora Garcete exibia `[]` tendo
 * dois campos em falta).
 *
 * ⚠️ O tipo é **jsonb**, não `text[]` — tanto o retorno de `fn_worker_missing_fields`
 * quanto a coluna `worker_blocked_applications.missing_fields`. Os dois ramos do
 * CASE têm de ser jsonb, senão o Postgres recusa a query inteira
 * (`CASE types text[] and jsonb cannot be matched`).
 *
 * @param workerAlias alias criado por `liveWorkerJoinSql`.
 */
export function liveMissingFieldsSql(workerAlias = 'lw'): string {
  return (
    `CASE WHEN NOT (${notFoundSql(workerAlias)}) ` +
    `AND NOT (${disabledSql(workerAlias)}) ` +
    `AND (${notRegisteredSql(workerAlias)}) ` +
    `THEN fn_worker_missing_fields(${workerAlias}.id) ` +
    `ELSE '[]'::jsonb ` +
    `END`
  );
}
