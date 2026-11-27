/**
 * vacancySemaphore (front) — o contrato do semáforo da vaga que a API entrega (change semaforo-da-vaga, F1/F2).
 *
 * O DONO da cor e do `n` é o back (`worker-functions/src/modules/matching/domain/vacancySemaphore.ts`): o front só PINTA o que
 * recebe e nunca recalcula a cor a partir de `n`. `worstSemaphore` (Kanban de pacientes) também vem pronto do servidor.
 */
export const SEMAPHORE_COLORS = ['red', 'yellow', 'green'] as const;
export type SemaphoreColor = (typeof SEMAPHORE_COLORS)[number];

/** `n` = prestadores em Seleccionado + Respuesta rápida, sem desvinculados. */
export interface VacancySemaphore {
  n: number;
  color: SemaphoreColor;
}
