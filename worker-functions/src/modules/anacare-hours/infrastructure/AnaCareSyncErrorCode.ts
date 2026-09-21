/**
 * src/modules/anacare-hours/infrastructure/AnaCareSyncErrorCode.ts
 *
 * F1 (migration 457, change `anacare-horas-conclusao-de-corrida`, 20/09/2026) — regra dura desta
 * change: `anacare_sync_run.last_error` NUNCA guarda `.message` de exceção. A mensagem pode
 * carregar nome de paciente (ex.: `AnaCarePatientMonthCollisionError` cita `anaCarePatientIds` na
 * frase) — PII não entra em banco (Ley 25.326, regra dura do CLAUDE.md do ebrain).
 *
 * `toStableErrorCode` mapeia por `instanceof` para as classes de erro CONHECIDAS deste módulo,
 * anexando o status HTTP que `AnaCareHoursSyncController.trigger` já devolve para cada uma (ex.:
 * `AnaCarePatientMonthCollisionError:409`). Qualquer exceção NÃO mapeada cai no fallback genérico
 * — `UnknownError:<NomeDaClasse>` — que usa só `err.constructor.name`, nunca `err.message`.
 */
import { AnaCarePatientMonthCollisionError } from './AnaCarePatientMonthRepository';

export function toStableErrorCode(err: unknown): string {
  if (err instanceof AnaCarePatientMonthCollisionError) {
    // 409 é o HTTP que `AnaCareHoursSyncController.trigger` já devolve para esta classe.
    return 'AnaCarePatientMonthCollisionError:409';
  }
  if (err instanceof Error) {
    // Fallback genérico: nome da classe REAL do erro, nunca `.message` (regra dura).
    return `UnknownError:${err.constructor.name}`;
  }
  return 'UnknownError:NonError';
}
