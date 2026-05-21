import httpMocks from 'node-mocks-http';
import type { Request } from 'express';

// ── Import ────────────────────────────────────────────────────────────────────

import { enforceOnBehalfOf } from '../enforceOnBehalfOf';
import { ServicePrincipal } from '../../../domain/ServicePrincipal';
import { createHash } from 'node:crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makePrincipal(name = 'triage-service'): ServicePrincipal {
  return new ServicePrincipal({
    name,
    allowedCapabilities: ['worker.profile.get'],
    tokenHashes: [sha256('any-token')],
  });
}

function makeAuditor() {
  return { emit: jest.fn() };
}

function makeReqWithPrincipal(
  overrides: httpMocks.RequestOptions,
  principal?: ServicePrincipal,
): Request {
  const req = httpMocks.createRequest(overrides);
  if (principal) {
    (req as unknown as Record<string, unknown>).servicePrincipal = principal;
  }
  return req as unknown as Request;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('enforceOnBehalfOf', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1 — Sucesso modo "params"
  it('sucesso modo params: header == req.params.workerId → next()', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });
    const principal = makePrincipal();

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-123' },
        params: { workerId: 'uuid-123' },
      },
      principal,
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as Record<string, unknown>).onBehalfOfWorkerId).toBe('uuid-123');
    expect(res.statusCode).toBe(200);
  });

  // 2 — Sucesso modo "body"
  it('sucesso modo body: header == req.body.workerId → next()', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'body' });
    const principal = makePrincipal();

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-123' },
        body: { workerId: 'uuid-123' },
      },
      principal,
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as Record<string, unknown>).onBehalfOfWorkerId).toBe('uuid-123');
  });

  // 3 — Sem header → 400 MISSING_HEADER
  it('sem header x-on-behalf-of-worker-id → 400 MISSING_HEADER', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });

    const req = makeReqWithPrincipal(
      { params: { workerId: 'uuid-123' } },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res._getData() as string) as Record<string, unknown>;
    expect(body.error).toContain('x-on-behalf-of-worker-id');
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'MISSING_HEADER' }),
    );
  });

  // 4 — Header vazio (empty string) → 400 MISSING_HEADER
  it('header vazio → 400 MISSING_HEADER', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': '' },
        params: { workerId: 'uuid-123' },
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'MISSING_HEADER' }),
    );
  });

  // 5 — WorkerId faltando em params → 400 MISSING_WORKER_ID
  it('workerId ausente em params → 400 MISSING_WORKER_ID', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-123' },
        params: {}, // sem workerId
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'MISSING_WORKER_ID' }),
    );
  });

  // 6 — WorkerId faltando em body → 400 MISSING_WORKER_ID
  it('workerId ausente em body → 400 MISSING_WORKER_ID', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'body' });

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-123' },
        body: { otherField: 'foo' }, // sem workerId
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'MISSING_WORKER_ID' }),
    );
  });

  // 7 — Mismatch params: header != param → 400 ON_BEHALF_OF_MISMATCH
  it('mismatch params: header != param.workerId → 400 ON_BEHALF_OF_MISMATCH', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-header' },
        params: { workerId: 'uuid-different' },
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'ON_BEHALF_OF_MISMATCH' }),
    );
  });

  // 8 — Mismatch body: header != body.workerId → 400 ON_BEHALF_OF_MISMATCH
  it('mismatch body: header != body.workerId → 400 ON_BEHALF_OF_MISMATCH', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'body' });

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-header' },
        body: { workerId: 'uuid-different' },
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  // 9 — req.onBehalfOfWorkerId injetado no sucesso
  it('sucesso: req.onBehalfOfWorkerId injetado com valor do header', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'worker-uuid-789' },
        params: { workerId: 'worker-uuid-789' },
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as Record<string, unknown>).onBehalfOfWorkerId).toBe(
      'worker-uuid-789',
    );
  });

  // 10 — Express lower-cases headers automaticamente
  it('header X-On-Behalf-Of-Worker-Id (mixed case) é aceito via Express lowercase', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });

    // httpMocks normaliza headers pra lowercase (mesma lógica do Express)
    const req = makeReqWithPrincipal(
      {
        headers: { 'X-On-Behalf-Of-Worker-Id': 'uuid-456' },
        params: { workerId: 'uuid-456' },
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  // 11 — Custom field (field: 'targetWorkerId') → funciona
  it('custom field "targetWorkerId" no params → funciona', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params', field: 'targetWorkerId' });

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-999' },
        params: { targetWorkerId: 'uuid-999' },
      },
      makePrincipal(),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as Record<string, unknown>).onBehalfOfWorkerId).toBe('uuid-999');
  });

  // 12 — Auditor recebe principal name do req.servicePrincipal em mismatch
  it('auditor.emit usa principal name em mismatch', () => {
    const auditor = makeAuditor();
    const middleware = enforceOnBehalfOf({ auditor, source: 'params' });
    const principal = makePrincipal('triage-service');

    const req = makeReqWithPrincipal(
      {
        headers: { 'x-on-behalf-of-worker-id': 'uuid-A' },
        params: { workerId: 'uuid-B' },
      },
      principal,
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ principal: 'triage-service' }),
    );
  });
});
