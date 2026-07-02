import httpMocks from 'node-mocks-http';
import type { Request } from 'express';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLoggerError = jest.fn();

jest.mock('@shared/logging/Logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
  },
}));

// ── Import depois dos mocks ──────────────────────────────────────────────────

import { requireServicePrincipal } from '../requireServicePrincipal';
import { ServicePrincipal } from '../../../domain/ServicePrincipal';
import { McpAuthError } from '../../../domain/McpErrors';
import { createHash } from 'node:crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makePrincipal(name = 'triage-service', token = 'valid-token'): ServicePrincipal {
  return new ServicePrincipal({
    name,
    allowedCapabilities: ['worker.profile.get'],
    tokenHashes: [sha256(token)],
  });
}

function makeRepo(principal: ServicePrincipal | null = null) {
  return {
    findByToken: jest.fn().mockResolvedValue(principal),
  };
}

function makeAuditor() {
  return { emit: jest.fn() };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('requireServicePrincipal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1 — Sucesso: token válido → req.servicePrincipal injetado, next() chamado
  it('sucesso: token válido injeta servicePrincipal e chama next()', async () => {
    const principal = makePrincipal();
    const repo = makeRepo(principal);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer valid-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as Record<string, unknown>).servicePrincipal).toBe(principal);
    expect(res.statusCode).toBe(200); // não alterado
  });

  // 2 — Sem header Authorization → 401, auditor logado com AUTH_FAILED
  it('sem header Authorization → 401, auditor emit errorCode=AUTH_FAILED', async () => {
    const repo = makeRepo();
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({});
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res._getData() as string) as Record<string, unknown>;
    expect(body.error).toBe('Unauthorized');
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', errorCode: 'AUTH_FAILED' }),
    );
  });

  // 3 — Header sem "Bearer " → 401
  it('header sem prefixo "Bearer " → 401', async () => {
    const repo = makeRepo();
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Token some-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  // 4 — Bearer com token vazio ("Bearer ") → 401
  it('"Bearer " com token vazio → 401', async () => {
    const repo = makeRepo();
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer ' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(repo.findByToken).not.toHaveBeenCalled();
  });

  // 5 — Token não encontrado em nenhum principal → 401
  it('token não encontrado → 401', async () => {
    const repo = makeRepo(null); // findByToken retorna null
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer wrong-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'AUTH_FAILED' }),
    );
  });

  // 6 — Repo.findByToken lança erro inesperado → 401 + logger.error chamado
  it('repo.findByToken lança erro inesperado → 401 + logger.error', async () => {
    const repo = {
      findByToken: jest.fn().mockRejectedValue(new Error('SM unavailable')),
    };
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer some-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'mcp: unexpected error in requireServicePrincipal',
    );
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INTERNAL' }),
    );
  });

  // 7 — Latência medida em latencyMs (>= 0)
  it('latencyMs no audit event é >= 0', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({});
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    const emitArg = (auditor.emit.mock.calls[0] as [Record<string, unknown>])[0];
    expect(typeof emitArg.latencyMs).toBe('number');
    expect(emitArg.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  // 8 — Sucesso loga via auditor também (outcome=success)
  it('sucesso loga audit com outcome=success', async () => {
    const principal = makePrincipal();
    const repo = makeRepo(principal);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer valid-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', principal: 'triage-service' }),
    );
  });

  // 9 — Header com case "AUTHORIZATION: Bearer X" (Express normaliza pra lowercase)
  it('header AUTHORIZATION (uppercase) é aceito — Express normaliza', async () => {
    const principal = makePrincipal();
    const repo = makeRepo(principal);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    // httpMocks normaliza headers pra lowercase como Express faz
    const req = httpMocks.createRequest({
      headers: { AUTHORIZATION: 'Bearer valid-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as Record<string, unknown>).servicePrincipal).toBe(principal);
  });

  // 10 — req.servicePrincipal é exatamente o ServicePrincipal retornado pelo repo
  it('req.servicePrincipal é a instância exata retornada pelo repo', async () => {
    const principal = makePrincipal('my-service', 'token-abc');
    const repo = makeRepo(principal);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer token-abc' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    const injected = (req as unknown as Record<string, unknown>).servicePrincipal;
    expect(injected).toBe(principal);
    expect((injected as ServicePrincipal).name).toBe('my-service');
  });

  // 11 — Token com whitespace ("Bearer    token   ") → trim aplicado
  it('token com whitespace extra → trim aplicado antes de chamar repo', async () => {
    const principal = makePrincipal();
    const repo = makeRepo(principal);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer    valid-token   ' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(repo.findByToken).toHaveBeenCalledWith('valid-token');
    expect(next).toHaveBeenCalledTimes(1);
  });

  // 12 — McpAuthError não aciona logger.error
  it('McpAuthError NÃO aciona logger.error (só falhas internas acionam)', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer bad-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  // ── OAuth (conector claude.ai) ─────────────────────────────────────────────

  const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJmb28iOiJiYXIifQ.c2ln';
  const RESOURCE_METADATA_URL =
    'https://mcp.example.com/.well-known/oauth-protected-resource/mcp/v1';

  function makeOAuthVerifier(result?: { scopes: string[]; extra?: Record<string, unknown> }) {
    return {
      verifyAccessToken: result
        ? jest.fn().mockResolvedValue(result)
        : jest.fn().mockRejectedValue(new Error('invalid token')),
    };
  }

  // 13 — access token OAuth válido → principal sintético read-only + next()
  it('OAuth: JWT válido vira principal sintético claude-ai:<email> com caps read-only', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const oauthVerifier = makeOAuthVerifier({
      scopes: ['worker:read'],
      extra: { email: 'ana@enlite.health', role: 'recruiter' },
    });
    const middleware = requireServicePrincipal({
      repo,
      auditor,
      oauthVerifier,
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });

    const req = httpMocks.createRequest({
      headers: { authorization: `Bearer ${FAKE_JWT}` },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const principal = (req as unknown as Record<string, unknown>)
      .servicePrincipal as ServicePrincipal;
    expect(principal.name).toBe('claude-ai:ana@enlite.health');
    expect(principal.isCapabilityAllowed('worker.profile.get')).toBe(true);
    expect(principal.isCapabilityAllowed('worker.profile.update')).toBe(false);
    expect(principal.isCapabilityAllowed('worker.documents.upload')).toBe(false);
    expect(repo.findByToken).not.toHaveBeenCalled();
    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', capability: 'auth.oauth' }),
    );
  });

  // 14 — JWT inválido → 401 com WWW-Authenticate (descoberta RFC 9728)
  it('OAuth: JWT inválido → 401 com header WWW-Authenticate', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({
      repo,
      auditor,
      oauthVerifier: makeOAuthVerifier(),
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });

    const req = httpMocks.createRequest({
      headers: { authorization: `Bearer ${FAKE_JWT}` },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(res.getHeader('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
  });

  // 15 — Sem header + resourceMetadataUrl → 401 já anuncia o WWW-Authenticate
  it('OAuth: request sem Authorization ganha WWW-Authenticate no 401', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({
      repo,
      auditor,
      oauthVerifier: makeOAuthVerifier(),
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });

    const req = httpMocks.createRequest({});
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.getHeader('WWW-Authenticate')).toContain('resource_metadata=');
  });

  // 16 — Sem oauthVerifier, token JWT-shaped cai no fluxo de service principal
  it('OAuth desabilitado: JWT-shaped token vai pro lookup de service principal', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({
      headers: { authorization: `Bearer ${FAKE_JWT}` },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(repo.findByToken).toHaveBeenCalledWith(FAKE_JWT);
    expect(res.statusCode).toBe(401);
    expect(res.getHeader('WWW-Authenticate')).toBeUndefined();
  });

  // 17 — Escopo desconhecido (sem capabilities) → 401
  it('OAuth: token com escopo sem capabilities mapeadas → 401', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({
      repo,
      auditor,
      oauthVerifier: makeOAuthVerifier({ scopes: ['unknown:scope'], extra: {} }),
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });

    const req = httpMocks.createRequest({
      headers: { authorization: `Bearer ${FAKE_JWT}` },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  // Extra — McpAuthError é throw corretamente sem a instância principal
  it('auditor.emit recebe principal="unknown" em falha de auth', async () => {
    const repo = makeRepo(null);
    const auditor = makeAuditor();
    const middleware = requireServicePrincipal({ repo, auditor });

    const req = httpMocks.createRequest({ headers: {} });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await middleware(req as unknown as Request, res, next);

    expect(auditor.emit).toHaveBeenCalledWith(
      expect.objectContaining({ principal: 'unknown' }),
    );
  });
});
