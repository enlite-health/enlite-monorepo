/**
 * AnaCareRateLimiter.test.ts
 *
 * Cobre o limite de carga D341: fila sequencial com intervalo mínimo configurável (2.4) e
 * circuit breaker após N falhas consecutivas (2.5). Relógio e sleep são injetados (virtual
 * clock) — o teste não depende de tempo real nem de `NODE_ENV`.
 *
 * Cada bloco tem sua sabotagem, executada e colada no relatório da task: comentar o trecho
 * correspondente do `AnaCareRateLimiter` faz o teste cair.
 */
import { AnaCareRateLimiter, AnaCareCircuitBreakerOpenError } from '../AnaCareRateLimiter';
import { AnaCareHttpError } from '../AnaCareHttpError';
import { logger } from '@shared/logging';

/** Relógio+sleep virtuais: sleep(ms) avança o relógio instantaneamente, sem esperar de verdade. */
function makeVirtualClock() {
  let time = 0;
  const now = () => time;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      time += ms;
      resolve();
    });
  return { now, sleep };
}

describe('AnaCareRateLimiter — fila sequencial e intervalo (2.4)', () => {
  it('N chamadas concorrentes viram fila sequencial com intervalo >= o configurado', async () => {
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 1000, now, sleep });
    const callTimestamps: number[] = [];

    const fn = () => {
      callTimestamps.push(now());
      return Promise.resolve('ok');
    };

    // 5 chamadas concorrentes (Promise.all) — todas disparadas no "mesmo instante".
    const results = await Promise.all([
      limiter.schedule(fn),
      limiter.schedule(fn),
      limiter.schedule(fn),
      limiter.schedule(fn),
      limiter.schedule(fn),
    ]);

    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(callTimestamps).toHaveLength(5);
    for (let i = 1; i < callTimestamps.length; i++) {
      const gap = callTimestamps[i] - callTimestamps[i - 1];
      expect(gap).toBeGreaterThanOrEqual(1000);
    }
  });

  it('respeita o intervalo mínimo configurado (não só o default de 1s)', async () => {
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 250, now, sleep });
    const callTimestamps: number[] = [];
    const fn = () => {
      callTimestamps.push(now());
      return Promise.resolve(null);
    };

    await Promise.all([limiter.schedule(fn), limiter.schedule(fn), limiter.schedule(fn)]);

    expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(250);
    expect(callTimestamps[2] - callTimestamps[1]).toBeGreaterThanOrEqual(250);
  });
});

describe('AnaCareRateLimiter — defaults reais (sem injeção de relógio/sleep)', () => {
  it('usa Date.now e setTimeout reais quando nada é injetado (2 chamadas: exercita o sleep real)', async () => {
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 5 });
    const results = await Promise.all([
      limiter.schedule(() => Promise.resolve('a')),
      limiter.schedule(() => Promise.resolve('b')),
    ]);
    expect(results).toEqual(['a', 'b']);
  }, 2000);
});

describe('AnaCareRateLimiter — circuit breaker (2.5)', () => {
  it('3 falhas consecutivas (5xx) abrem o breaker; a 4a chamada NEM entra na fila', async () => {
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({
      minIntervalMs: 0,
      maxAttempts: 1, // sem retry aqui — queremos testar o breaker, não o backoff
      breakerThreshold: 3,
      now,
      sleep,
    });

    const attemptedCalls: number[] = [];
    const failingFn = (n: number) => () => {
      attemptedCalls.push(n);
      return Promise.reject(new AnaCareHttpError('GET', '/api/shifts/', 500, 'boom'));
    };

    await expect(limiter.schedule(failingFn(1))).rejects.toThrow(AnaCareHttpError);
    await expect(limiter.schedule(failingFn(2))).rejects.toThrow(AnaCareHttpError);
    await expect(limiter.schedule(failingFn(3))).rejects.toThrow(AnaCareHttpError);

    expect(limiter.isOpen).toBe(true);
    expect(attemptedCalls).toEqual([1, 2, 3]);

    // 4a chamada: o breaker está aberto, então `failingFn(4)` NUNCA É INVOCADA.
    const fourthCall = jest.fn(failingFn(4));
    await expect(limiter.schedule(fourthCall)).rejects.toThrow(AnaCareCircuitBreakerOpenError);
    expect(fourthCall).not.toHaveBeenCalled();
    expect(attemptedCalls).toEqual([1, 2, 3]); // nada novo entrou
  });

  it('sucesso zera o contador de falhas consecutivas (breaker não abre por falhas não-adjacentes)', async () => {
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, breakerThreshold: 3, now, sleep });
    const fail = () => Promise.reject(new AnaCareHttpError('GET', '/x', 503, 'x'));
    const ok = () => Promise.resolve('ok');

    await expect(limiter.schedule(fail)).rejects.toThrow();
    await expect(limiter.schedule(fail)).rejects.toThrow();
    await expect(limiter.schedule(ok)).resolves.toBe('ok'); // zera o contador
    await expect(limiter.schedule(fail)).rejects.toThrow();
    await expect(limiter.schedule(fail)).rejects.toThrow();

    expect(limiter.isOpen).toBe(false); // só 2 consecutivas desde o último sucesso
  });

  it('backoff exponencial+jitter tenta de novo em falha transiente antes de desistir', async () => {
    const { now, sleep } = makeVirtualClock();
    const sleepSpy = jest.fn(sleep);
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 3, breakerThreshold: 5, now, sleep: sleepSpy });
    let attempts = 0;
    const fn = () => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new AnaCareHttpError('GET', '/x', 429, 'rate limited'));
      return Promise.resolve('ok-on-3rd');
    };

    await expect(limiter.schedule(fn)).resolves.toBe('ok-on-3rd');
    expect(attempts).toBe(3);
    // 2 sleeps de backoff (entre tentativa 1->2 e 2->3); o 3o não retry pq deu certo.
    expect(sleepSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('maxAttempts: 0 é configuração inválida — lança em vez de silenciar', async () => {
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 0, now, sleep });
    await expect(limiter.schedule(() => Promise.resolve('unreachable'))).rejects.toThrow(/maxAttempts/);
  });

  it('erro não-transiente (4xx != 429) não faz retry', async () => {
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 5, breakerThreshold: 5, now, sleep });
    let attempts = 0;
    const fn = () => {
      attempts += 1;
      return Promise.reject(new AnaCareHttpError('GET', '/x', 400, 'bad request'));
    };

    await expect(limiter.schedule(fn)).rejects.toThrow(AnaCareHttpError);
    expect(attempts).toBe(1);
  });
});

describe('AnaCareRateLimiter — logging estruturado na abertura do breaker (achado 4)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as ReturnType<typeof logger.warn>);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('loga (logger.warn, nunca console.*) só metadado — contagem e limiar — quando o breaker abre', async () => {
    const realConsoleWarn = jest.spyOn(console, 'warn');
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, breakerThreshold: 2, now, sleep });
    const fail = () =>
      Promise.reject(new AnaCareHttpError('GET', '/api/shifts/', 500, 'PACIENTE-NUNCA-DEVE-VAZAR'));

    await expect(limiter.schedule(fail)).rejects.toThrow(AnaCareHttpError);
    expect(warnSpy).not.toHaveBeenCalled(); // 1a falha: ainda não atingiu o limiar

    await expect(limiter.schedule(fail)).rejects.toThrow(AnaCareHttpError);
    expect(warnSpy).toHaveBeenCalledTimes(1); // 2a falha: limiar atingido, breaker abre
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('circuit breaker aberto'),
        consecutiveFailures: 2,
        breakerThreshold: 2,
      }),
    );
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('PACIENTE-NUNCA-DEVE-VAZAR');
    }
    expect(realConsoleWarn).not.toHaveBeenCalled();
    realConsoleWarn.mockRestore();
  });
});
