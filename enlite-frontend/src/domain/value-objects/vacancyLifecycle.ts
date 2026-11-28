/**
 * vacancyLifecycle (front) — o espelho do dono do selo da vaga (semaforo-da-vaga F4).
 *
 * O DONO é `worker-functions/src/modules/matching/domain/vacancyLifecycle.ts`: o back calcula o selo (`lifecycle`) e a tela
 * só o TRADUZ. Ninguém escolhe estado para a vaga: "no ar" é o dono de publicável (`vacancyPublication.ts`, só no back).
 * Esta lista é conferida contra a do back por `vacancyWritableStatuses.contract.test.ts` (lê este arquivo) — se divergirem, o CI
 * reprova. Não há mapa de valores de banco no front: o legado (`SEARCHING_REPLACEMENT`…) nunca chega aqui.
 */

/** O selo tem 2 valores; o resto da vaga fica sem selo (`null`). */
export const CICLOS_DE_VIDA = ['rascunho', 'baja'] as const;
export type CicloDeVida = (typeof CICLOS_DE_VIDA)[number];

/** O que a tela pode GRAVAR em `status`: nada. O servidor recusa qualquer `status` com 400 `VACANCY_STATUS_NOT_WRITABLE`. */
export const STATUS_GRAVAVEIS = [] as const;
