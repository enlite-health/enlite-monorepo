import { ApiError } from '@infrastructure/http/ApiError';

/**
 * Rastreabilidade do login administrativo (Google e email/senha).
 *
 * Cada tentativa de login abre um trace com id próprio; cada etapa
 * (sign-in Firebase → checagem de domínio → chamada ao backend → refresh de
 * token → leitura do store → redirect) emite uma linha correlacionada por esse
 * id, com o tempo decorrido desde o início. Assim dá pra reconstruir, no
 * console do navegador, EXATAMENTE onde um login parou — em vez de só ver a
 * mensagem genérica "não possui permissões de administrador".
 *
 * As últimas ~100 etapas ficam em `window.__adminLoginTrace` para inspeção
 * pós-falha (`copy(window.__adminLoginTrace)` no console).
 */

export type AuthFlow = 'google' | 'password';
export type AuthOutcome = 'success' | 'denied' | 'error';

export interface AuthTraceHandle {
  readonly id: string;
  /** Etapa concluída com sucesso. */
  step(name: string, data?: Record<string, unknown>): void;
  /** Etapa que falhou — anexa status/mensagem do erro. */
  fail(name: string, error: unknown): void;
  /** Fecha o trace com o desfecho da tentativa. */
  end(outcome: AuthOutcome, data?: Record<string, unknown>): void;
}

interface TraceEntry {
  trace: string;
  flow: AuthFlow;
  step: string;
  elapsedMs: number;
  level: 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

const RING_MAX = 100;

function ringBuffer(): TraceEntry[] {
  if (typeof window === 'undefined') return [];
  const w = window as unknown as { __adminLoginTrace?: TraceEntry[] };
  if (!w.__adminLoginTrace) w.__adminLoginTrace = [];
  return w.__adminLoginTrace;
}

/** Extrai o essencial de um erro para o log — incluindo o HTTP status. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) {
    return { kind: 'ApiError', status: error.status, message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  return { kind: 'unknown', message: String(error) };
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

let counter = 0;

export function startAuthTrace(flow: AuthFlow): AuthTraceHandle {
  counter += 1;
  const id = `login-${Date.now().toString(36)}-${counter}`;
  const t0 = now();

  const emit = (level: TraceEntry['level'], name: string, data?: Record<string, unknown>): void => {
    const elapsedMs = Math.round(now() - t0);
    const buf = ringBuffer();
    buf.push({ trace: id, flow, step: name, elapsedMs, level, data });
    if (buf.length > RING_MAX) buf.splice(0, buf.length - RING_MAX);

    const line = `[admin-login ${flow}] ${id} +${elapsedMs}ms ${name}`;
    if (level === 'error') console.error(line, data ?? '');
    else if (level === 'warn') console.warn(line, data ?? '');
    else console.info(line, data ?? '');
  };

  emit('info', 'start');

  return {
    id,
    step: (name, data) => emit('info', name, data),
    fail: (name, error) => emit('error', name, describeError(error)),
    end: (outcome, data) => emit(outcome === 'success' ? 'info' : 'warn', `end:${outcome}`, data),
  };
}
