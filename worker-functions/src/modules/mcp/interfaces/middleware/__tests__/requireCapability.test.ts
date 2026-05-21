import httpMocks from 'node-mocks-http';
import type { Request } from 'express';

// ── Import ────────────────────────────────────────────────────────────────────

import { requireCapability } from '../requireCapability';
import { ServicePrincipal } from '../../../domain/ServicePrincipal';
import { createHash } from 'node:crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makePrincipal(
  name = 'triage-service',
  capabilities: string[] = ['worker.profile.get'],
): ServicePrincipal {
  return new ServicePrincipal({
    name,
    allowedCapabilities: capabilities,
    tokenHashes: [sha256('any-token')],
  });
}

function makeAuditor() {
  return { emit: jest.fn() };
}

function makeReqWithPrincipal(
  principal?: ServicePrincipal,
  onBehalfOfWorkerId?: string,
): Request {
  const req = httpMocks.createRequest({});
  if (principal) {
    (req as unknown as Record<string, unknown>).servicePrincipal = principal;
  }
  if (onBehalfOfWorkerId) {
    (req as unknown as Record<string, unknown>).onBehalfOfWorkerId = onBehalfOfWorkerId;
  }
  return req as unknown as Request;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('requireCapability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1 — Sucesso: principal tem a capability → next() chamado
  it('sucesso: principal tem a capability → next()', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.profile.get' });
    const req = makeReqWithPrincipal(makePrincipal('triage-service', ['worker.profile.get']));
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(auditor.emit).not.toHaveBeenCalled();
  });

  // 2 — Principal não setado (middleware ordem errada) → 401
  it('principal ausente (middleware fora de ordem) → 401', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.profile.get' });
    const req = makeReqWithPrincipal(); // sem servicePrincipal
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    const body = JSON.parse(res._getData() as string) as Record<string, unknown>;
    expect(body.error).toBe('Unauthorized');
    expect(auditor.emit).not.toHaveBeenCalled();
  });

  // 3 — Capability não na allowlist → 403 CAPABILITY_NOT_ALLOWED
  it('capability não permitida → 403 CAPABILITY_NOT_ALLOWED', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.vacancies.list' });
    const req = makeReqWithPrincipal(
      makePrincipal('triage-service', ['worker.profile.get']), // sem vacancies.list
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'CAPABILITY_NOT_ALLOWED' }),
    );
  });

  // 4 — Mensagem do erro inclui nome do principal e capability
  it('mensagem de erro 403 inclui nome do principal e capability', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.documents.upload' });
    const req = makeReqWithPrincipal(
      makePrincipal('triage-service', ['worker.profile.get']),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    const body = JSON.parse(res._getData() as string) as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    const errorMsg = body.error as string;
    expect(errorMsg).toContain('triage-service');
    expect(errorMsg).toContain('worker.documents.upload');
  });

  // 5 — Audit logado em erro com campos corretos
  it('audit logado em erro com principal, capability e latencyMs', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.interview.get' });
    const req = makeReqWithPrincipal(
      makePrincipal('triage-service', []),
      'worker-uuid-777',
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(auditor.emit).toHaveBeenCalledTimes(1);
    const emitArg = (auditor.emit.mock.calls[0] as [Record<string, unknown>])[0];
    expect(emitArg.principal).toBe('triage-service');
    expect(emitArg.capability).toBe('worker.interview.get');
    expect(emitArg.onBehalfOfWorkerId).toBe('worker-uuid-777');
    expect(emitArg.outcome).toBe('error');
    expect(typeof emitArg.latencyMs).toBe('number');
    expect(emitArg.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  // 6 — Audit NÃO logado em sucesso
  it('audit NÃO é emitido em sucesso (só falhas são auditadas aqui)', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.profile.get' });
    const req = makeReqWithPrincipal(
      makePrincipal('triage-service', ['worker.profile.get']),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(auditor.emit).not.toHaveBeenCalled();
  });

  // 7 — Múltiplas capabilities: tem a capability certa dentre várias → sucesso
  it('principal com múltiplas capabilities: tem a requerida → next()', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.vacancies.list' });
    const req = makeReqWithPrincipal(
      makePrincipal('triage-service', [
        'worker.profile.get',
        'worker.vacancies.list',
        'worker.interview.get',
      ]),
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(auditor.emit).not.toHaveBeenCalled();
  });

  // 8 — onBehalfOfWorkerId null quando não injetado pelo middleware anterior
  it('audit onBehalfOfWorkerId=null se não havia sido injetado', () => {
    const auditor = makeAuditor();
    const middleware = requireCapability({ auditor, capability: 'worker.documents.upload' });
    const req = makeReqWithPrincipal(
      makePrincipal('triage-service', []), // sem capability, sem onBehalfOfWorkerId
    );
    const res = httpMocks.createResponse();
    const next = jest.fn();

    middleware(req, res, next);

    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ onBehalfOfWorkerId: null }),
    );
  });
});
