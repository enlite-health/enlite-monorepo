/**
 * AnaCareRateLimiter — limite de carga D341, compartilhado entre portas do Ana Care
 * (hoje `AnaCareShiftsSource`; a porta de paciente `AnaCarePatientApi` ficou de fora desta stage
 * porque a reconciliação de paciente passou a ser manual — decisão do Gabriel, 16/09) porque é
 * sobre o Ana Care como um todo, não por porta (spec F2 "se cair").
 *
 * Três regras, cada uma com sabotagem própria (fase-2.md "termina quando"):
 *   1. Fila sequencial: 1 requisição por vez, intervalo mínimo configurável (default 1s).
 *   2. Backoff exponencial+jitter em falha transiente (429/5xx/timeout) — mesma fórmula de
 *      `gemini-fetch.ts::fetchGeminiWithRetry`, extraída para `shared/http/backoff.ts` (achado 2
 *      da F2: as constantes eram cópia literal entre os dois arquivos). O classificador de
 *      "é transiente?" continua LOCAL a cada chamador (`isTransient` abaixo) — só a fórmula do
 *      atraso é compartilhada. A LISTA de status (429/5xx) em si é compartilhada com
 *      `AnaCareSessionClient.ts` via `isTransientHttpStatus` (achado do gate `revisao-pr`, F2) —
 *      só o "o que fazer com um erro que não é `AnaCareHttpError`" (timeout/rede) fica aqui.
 *   3. Circuit breaker: N falhas CONSECUTIVAS (contadas por chamada já sem retry, não por
 *      tentativa) abrem o breaker — a chamada seguinte nem entra na fila (não toca rede/mock).
 *      Sucesso zera o contador.
 *
 * Relógio (`now`) e `sleep` são injetáveis para teste com clock virtual — nunca depende de
 * `NODE_ENV==='test'` para os testes desta classe (ao contrário de gemini-fetch.ts).
 */

import { AnaCareHttpError } from './AnaCareHttpError';
import { computeBackoffDelayMs } from '@shared/http/backoff';
import { isTransientHttpStatus } from '@shared/http/isTransientHttpStatus';
import { logger } from '@shared/logging';

export class AnaCareCircuitBreakerOpenError extends Error {
  constructor() {
    super('anacare_circuit_breaker_open');
    this.name = 'AnaCareCircuitBreakerOpenError';
  }
}

export interface AnaCareRateLimiterOptions {
  /** Intervalo mínimo entre o INÍCIO de uma chamada e o início da próxima. Default 1000ms. */
  minIntervalMs?: number;
  /** Tentativas por chamada (1 tentativa inicial + retries). Default 5. */
  maxAttempts?: number;
  /** Falhas consecutivas (por chamada, pós-retry) que abrem o breaker. Default 3. */
  breakerThreshold?: number;
  /** Injeção de relógio — default Date.now. */
  now?: () => number;
  /** Injeção de sleep — default setTimeout real. */
  sleep?: (ms: number) => Promise<void>;
  /** Classifica erro como transiente (retry) ou definitivo (falha imediata). */
  isTransient?: (err: unknown) => boolean;
}

function defaultIsTransient(err: unknown): boolean {
  if (err instanceof AnaCareHttpError) {
    return isTransientHttpStatus(err.status);
  }
  // AnaCareTimeoutError e qualquer erro de rede (fetch throw) contam como transiente.
  return true;
}

export class AnaCareRateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly breakerThreshold: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly isTransient: (err: unknown) => boolean;

  private tail: Promise<void> = Promise.resolve();
  private lastCallStartedAt: number | null = null;
  private consecutiveFailures = 0;
  private breakerOpenFlag = false;

  constructor(options: AnaCareRateLimiterOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.breakerThreshold = options.breakerThreshold ?? 3;
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.isTransient = options.isTransient ?? defaultIsTransient;
  }

  get isOpen(): boolean {
    return this.breakerOpenFlag;
  }

  /**
   * Agenda `fn` na fila sequencial. Cada chamador recebe SEU PRÓPRIO resultado/rejeição —
   * a fila só serializa a EXECUÇÃO, nunca funde erros de chamadas diferentes.
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tail;
    let releaseNext!: () => void;
    this.tail = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });

    await previousTail;
    try {
      return await this.runOne(fn);
    } finally {
      releaseNext();
    }
  }

  private async runOne<T>(fn: () => Promise<T>): Promise<T> {
    if (this.breakerOpenFlag) {
      throw new AnaCareCircuitBreakerOpenError();
    }

    await this.waitForMinInterval();
    this.lastCallStartedAt = this.now();

    try {
      const result = await this.withRetry(fn);
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.breakerThreshold && !this.breakerOpenFlag) {
        this.breakerOpenFlag = true;
        // PII-SAFETY: só contagem/limiar, nunca corpo de resposta nem dado de paciente/prestador.
        logger.warn({
          msg: '[AnaCareRateLimiter] circuit breaker aberto — falhas consecutivas atingiram o limite',
          consecutiveFailures: this.consecutiveFailures,
          breakerThreshold: this.breakerThreshold,
        });
      }
      throw err;
    }
  }

  private async waitForMinInterval(): Promise<void> {
    if (this.lastCallStartedAt === null) return;
    const elapsed = this.now() - this.lastCallStartedAt;
    const remaining = this.minIntervalMs - elapsed;
    if (remaining > 0) {
      await this.sleepFn(remaining);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    // O loop sempre RETORNA (linha `return await fn()`) ou LANÇA (`throw err` no último
    // attempt, ou em erro não-transiente) — nunca cai fora do for sem um dos dois.
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const isLast = attempt === this.maxAttempts - 1;
        if (!this.isTransient(err) || isLast) {
          throw err;
        }
        await this.sleepFn(computeBackoffDelayMs(attempt));
      }
    }
    // maxAttempts <= 0 é o único jeito de chegar aqui (configuração inválida).
    throw new Error('AnaCareRateLimiter: maxAttempts must be >= 1');
  }
}
