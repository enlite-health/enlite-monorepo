import { Request, Response, NextFunction } from 'express';
import { correlationMiddleware } from '../correlationMiddleware';
import { loggingAls } from '../als';

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

const fakeRes = {} as Response;

describe('correlationMiddleware', () => {
  test('Test 1 — extracts TRACE_ID from X-Cloud-Trace-Context header', (done) => {
    const req = makeReq({
      'x-cloud-trace-context': 'abc123trace/00001;o=1',
    });

    const next: NextFunction = () => {
      const store = loggingAls.getStore();
      expect(store).toBeDefined();
      expect(store?.traceId).toBe('abc123trace');
      done();
    };

    correlationMiddleware(req, fakeRes, next);
  });

  test('Test 2 — generates UUID v4 when header is absent', (done) => {
    const req = makeReq({});
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const next: NextFunction = () => {
      const store = loggingAls.getStore();
      expect(store).toBeDefined();
      expect(store?.traceId).toMatch(uuidV4Regex);
      done();
    };

    correlationMiddleware(req, fakeRes, next);
  });

  test('Test 3 — next() is called inside the ALS context', (done) => {
    const req = makeReq({ 'x-cloud-trace-context': 'trace999/0;o=1' });
    let traceIdInsideNext: string | undefined;

    const next: NextFunction = () => {
      traceIdInsideNext = loggingAls.getStore()?.traceId;
      expect(traceIdInsideNext).toBe('trace999');
      done();
    };

    correlationMiddleware(req, fakeRes, next);
  });
});
