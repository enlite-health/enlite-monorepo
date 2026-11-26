/**
 * vacancyLifecycle (front) — o espelho do dono do ciclo de vida da vaga (estado-automatico-do-paciente, F2, D3/E5).
 *
 * O DONO é `worker-functions/src/modules/matching/domain/vacancyLifecycle.ts`: o back calcula o ciclo (`lifecycle`) e a tela
 * só o TRADUZ. Esta lista é conferida contra a do back por `vacancyWritableStatuses.contract.test.ts` (lê este arquivo) — se
 * divergirem, o CI reprova. Não há mapa de valores de banco no front: o legado (`SEARCHING_REPLACEMENT`…) nunca chega aqui.
 */

export const CICLOS_DE_VIDA = ['rascunho', 'aberta', 'pausada', 'cerrada', 'baja'] as const;
export type CicloDeVida = (typeof CICLOS_DE_VIDA)[number];

/** O que o editor da vaga e o wizard podem GRAVAR em `status` (E5). O servidor recusa o resto com 400 `VACANCY_STATUS_NOT_LIFECYCLE`. */
export const STATUS_GRAVAVEIS = ['SEARCHING', 'ON_HOLD', 'SUSPENDED', 'CLOSED'] as const;
export type StatusGravavel = (typeof STATUS_GRAVAVEIS)[number];
