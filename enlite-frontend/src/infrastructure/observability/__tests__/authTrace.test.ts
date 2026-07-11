import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAuthTrace, describeError } from '../authTrace';
import { ApiError } from '@infrastructure/http/ApiError';

describe('authTrace', () => {
  beforeEach(() => {
    (window as unknown as { __adminLoginTrace?: unknown }).__adminLoginTrace = undefined;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const buffer = (): Array<Record<string, unknown>> =>
    (window as unknown as { __adminLoginTrace: Array<Record<string, unknown>> }).__adminLoginTrace;

  const last = (): Record<string, unknown> => {
    const b = buffer();
    return b[b.length - 1];
  };

  it('emite a etapa start e expõe um id de trace', () => {
    const trace = startAuthTrace('google');
    expect(trace.id).toMatch(/^login-/);
    expect(buffer()).toHaveLength(1);
    expect(buffer()[0]).toMatchObject({ step: 'start', flow: 'google', level: 'info' });
  });

  it('registra etapas de sucesso com dados anexados', () => {
    const trace = startAuthTrace('password');
    trace.step('backend-profile:ok', { role: 'admin' });
    expect(last()).toMatchObject({ step: 'backend-profile:ok', level: 'info', data: { role: 'admin' } });
  });

  it('captura o HTTP status ao falhar com ApiError (404 = não-admin)', () => {
    const trace = startAuthTrace('password');
    trace.fail('backend-profile', new ApiError({ success: false, error: 'Admin user not found' }, 404));
    const entry = last();
    expect(entry.level).toBe('error');
    expect(entry.data).toMatchObject({ kind: 'ApiError', status: 404, message: 'Admin user not found' });
  });

  it('marca o desfecho: denied/error em warn, success em info', () => {
    const trace = startAuthTrace('google');
    trace.end('denied');
    expect(last()).toMatchObject({ step: 'end:denied', level: 'warn' });

    const ok = startAuthTrace('google');
    ok.end('success');
    expect(last()).toMatchObject({ step: 'end:success', level: 'info' });
  });

  it('mantém o ring buffer limitado a 100 entradas', () => {
    const trace = startAuthTrace('password'); // 1 (start)
    for (let i = 0; i < 150; i++) trace.step(`s${i}`);
    expect(buffer()).toHaveLength(100);
    // a mais antiga foi descartada; a última é a mais recente
    expect(last()).toMatchObject({ step: 's149' });
  });
});

describe('describeError', () => {
  it('extrai status/message/code de ApiError', () => {
    const e = new ApiError({ success: false, error: 'boom', code: 'X' }, 500);
    expect(describeError(e)).toMatchObject({ kind: 'ApiError', status: 500, message: 'boom', code: 'X' });
  });

  it('extrai name/message de Error comum (ex.: falha de rede)', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toMatchObject({
      kind: 'TypeError',
      message: 'Failed to fetch',
    });
  });

  it('lida com throw não-Error', () => {
    expect(describeError('weird')).toMatchObject({ kind: 'unknown', message: 'weird' });
  });
});
