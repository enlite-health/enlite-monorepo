/**
 * Porta driven da presença (emenda 077 §2.1): o attendance é o dono de "a guarda foi fechada" (`shift_attendance.status`).
 * O WF só lê, por `POST /internal/v1/presence/lookup`. `NONE` (sem linha) é DISTINTO de `OPEN`, e os dois impedem o informe.
 */
export type PresenceStatus = 'NONE' | 'OPEN' | 'CLOSED' | 'CLOSED_DECLARED';

/** Fechada = checkout do app aceito (`CLOSED`) ou saída declarada (`CLOSED_DECLARED`). */
export const isPresenceClosed = (s: PresenceStatus): boolean => s === 'CLOSED' || s === 'CLOSED_DECLARED';

export interface PresenceReader {
  /** Lança `PresenceUnavailableError` se o attendance estiver fora do ar, lento (> timeout) ou responder fora do contrato. */
  statusOf(occurrenceId: string): Promise<PresenceStatus>;
}

/** Vira `503 UPSTREAM_UNAVAILABLE` no controller (o app adia). A causa é um código curto: nunca corpo, nunca token. */
export class PresenceUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`presence_unavailable:${reason}`);
    this.name = 'PresenceUnavailableError';
  }
}
