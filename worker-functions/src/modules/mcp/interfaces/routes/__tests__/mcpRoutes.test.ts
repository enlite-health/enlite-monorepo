import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock requireServicePrincipal so we can control auth outcome per test
const mockRequireServicePrincipal = jest.fn();
jest.mock('../../middleware/requireServicePrincipal', () => ({
  requireServicePrincipal: () => mockRequireServicePrincipal,
}));

// Mock McpServer and StreamableHTTPServerTransport (SDK heavy deps)
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockServerClose = jest.fn().mockResolvedValue(undefined);
const mockRegisterAll = jest.fn();
const mockTransportClose = jest.fn().mockResolvedValue(undefined);

// handleRequest must write a response so supertest does not hang
const mockHandleRequest = jest.fn().mockImplementation(
  (_req: unknown, res: import('http').ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }));
    return Promise.resolve();
  },
);

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockServerClose,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation(() => ({
    handleRequest: mockHandleRequest,
    close: mockTransportClose,
  })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { createMcpRoutes } from '../mcpRoutes';
import type { Request, Response, NextFunction } from 'express';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(authPasses: boolean) {
  if (authPasses) {
    // Middleware injects servicePrincipal and calls next
    mockRequireServicePrincipal.mockImplementation(
      (_req: Request, _res: Response, next: NextFunction) => next(),
    );
  } else {
    // Middleware rejects with 401
    mockRequireServicePrincipal.mockImplementation(
      (_req: Request, res: Response) => {
        res.status(401).json({ error: 'Unauthorized' });
      },
    );
  }

  const app = express();
  app.use(express.json());

  const router = createMcpRoutes({
    principalRepo: {} as never,
    auditor: {} as never,
    registry: { registerAll: mockRegisterAll } as never,
    serverName: 'test-mcp',
    serverVersion: '0.0.1',
  });

  app.use('/mcp', router);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mcpRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default: handleRequest writes a minimal JSON response so supertest resolves
    mockHandleRequest.mockImplementation(
      (_req: unknown, res: import('http').ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }));
        return Promise.resolve();
      },
    );
  });

  // 1. POST /v1 sem auth → 401
  it('POST /mcp/v1 without auth returns 401', async () => {
    const app = makeApp(false);

    const res = await request(app).post('/mcp/v1').send({});

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
    // SDK should not be called
    expect(mockConnect).not.toHaveBeenCalled();
  });

  // 2. GET /v1 → 405
  it('GET /mcp/v1 returns 405 (stateless mode — no session endpoint)', async () => {
    const app = makeApp(true);

    const res = await request(app).get('/mcp/v1');

    expect(res.status).toBe(405);
    expect(res.body).toMatchObject({ error: 'Method not allowed in stateless mode' });
  });

  // 3. DELETE /v1 → 405
  it('DELETE /mcp/v1 returns 405', async () => {
    const app = makeApp(true);

    const res = await request(app).delete('/mcp/v1');

    expect(res.status).toBe(405);
    expect(res.body).toMatchObject({ error: 'Method not allowed in stateless mode' });
  });

  // 4. POST /v1 com auth válida → SDK connect + handleRequest são chamados
  it('POST /mcp/v1 with valid auth connects McpServer and calls handleRequest', async () => {
    const app = makeApp(true);

    await request(app)
      .post('/mcp/v1')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockHandleRequest).toHaveBeenCalledTimes(1);
  });

  // 5. registry.registerAll é chamado com o server correto
  it('registerAll is called on each authenticated POST request', async () => {
    const app = makeApp(true);

    await request(app)
      .post('/mcp/v1')
      .set('Content-Type', 'application/json')
      .send({});

    expect(mockRegisterAll).toHaveBeenCalledTimes(1);
    // First arg is the McpServer instance, second is a function (getPrincipal)
    expect(typeof (mockRegisterAll.mock.calls[0] as unknown[])[1]).toBe('function');
  });
});
