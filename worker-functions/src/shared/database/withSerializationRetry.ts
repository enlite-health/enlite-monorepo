/**
 * withSerializationRetry — repete uma unidade de trabalho transacional quando o Postgres a derruba por conflito de concorrência
 * (spec 058, plan §1.3). `40001` serialization_failure e `40P01` deadlock_detected: 3 tentativas no total; esgotadas, lança
 * `ConcurrencyConflictError` (HTTP 409). O isolamento do app é READ COMMITTED, então na prática só `40P01` aparece (o lock do paciente
 * serializa os escritores do vínculo). Qualquer OUTRO erro passa direto, sem repetir.
 *
 * `fn` deve abrir e fechar a PRÓPRIA transação (BEGIN … COMMIT/ROLLBACK): repetir dentro de uma transação já abortada não adianta.
 */
export const SERIALIZATION_ATTEMPTS = 3;
const RETRYABLE = new Set(['40001', '40P01']);

export class ConcurrencyConflictError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';
  readonly httpStatus = 409;
  constructor(readonly sqlState: string, readonly attempts: number) {
    super(`conflito de concorrência (${sqlState}) após ${attempts} tentativas`);
    this.name = 'ConcurrencyConflictError';
  }
}

const sqlStateOf = (e: unknown): string | undefined => (e as { code?: unknown } | null)?.code as string | undefined;

export async function withSerializationRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const state = sqlStateOf(e);
      if (state === undefined || !RETRYABLE.has(state)) throw e;
      if (attempt >= SERIALIZATION_ATTEMPTS) throw new ConcurrencyConflictError(state, attempt);
    }
  }
}
