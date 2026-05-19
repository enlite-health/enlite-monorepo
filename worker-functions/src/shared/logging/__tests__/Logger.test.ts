/**
 * Logger tests — instantiate a fresh pino logger with the same config as
 * Logger.ts but write to an in-memory stream so we can assert synchronously.
 *
 * We test the configuration (formatters.level, mixin) in isolation; the
 * exported `logger` singleton is covered by integration/E2E.
 */
import { Writable } from 'stream';
import pino from 'pino';
import { loggingAls } from '../als';

/** Build a test logger that writes JSON lines to an in-memory buffer. */
function buildTestLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });

  const testLogger = pino(
    {
      messageKey: 'message',
      formatters: {
        level(label: string) {
          const map: Record<string, string> = {
            trace: 'DEBUG', debug: 'DEBUG', info: 'INFO',
            warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL',
          };
          return { severity: map[label] ?? 'DEFAULT' };
        },
      },
      mixin() {
        const store = loggingAls.getStore();
        if (!store) return {};
        const ctx: Record<string, string> = { traceId: store.traceId };
        if (store.workerId !== undefined) ctx.workerId = store.workerId;
        if (store.jobPostingId !== undefined) ctx.jobPostingId = store.jobPostingId;
        if (store.batchId !== undefined) ctx.batchId = store.batchId;
        return ctx;
      },
    },
    dest,
  );

  return {
    logger: testLogger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('Logger', () => {
  test('Test 1 — traceId from ALS is injected into every log line', (done) => {
    const { logger: log, lines } = buildTestLogger();
    loggingAls.run({ traceId: 'abc-123' }, () => {
      log.info({ foo: 'bar' }, 'hello');
      // pino flushes synchronously to Writable when no transport is used
      const parsed = lines();
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toMatchObject({ traceId: 'abc-123', foo: 'bar', message: 'hello' });
      done();
    });
  });

  test('Test 2 — logger.error maps to severity ERROR', () => {
    const { logger: log, lines } = buildTestLogger();
    log.error('something broke');
    const parsed = lines();
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toMatchObject({ severity: 'ERROR', message: 'something broke' });
  });

  test('Test 3 — child logger preserves parent bindings and ALS context', (done) => {
    const { logger: log, lines } = buildTestLogger();
    loggingAls.run({ traceId: 'parent-trace', workerId: 'w-42' }, () => {
      const child = log.child({ jobPostingId: 'j-99' });
      child.info('child log');
      const parsed = lines();
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toMatchObject({
        traceId: 'parent-trace',
        workerId: 'w-42',
        jobPostingId: 'j-99',
        message: 'child log',
      });
      done();
    });
  });
});
