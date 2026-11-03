import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  requireServicePrincipal,
  type OAuthAccessTokenVerifier,
} from '../middleware/requireServicePrincipal';
import type { ServicePrincipalSecretManagerRepo } from '../../infrastructure/ServicePrincipalSecretManagerRepo';
import type { McpAuditLogger } from '../../infrastructure/McpAuditLogger';
import type { CapabilityRegistry } from '../../application/CapabilityRegistry';
import { agentCallOf } from '../middleware/agentActorContext';

interface Deps {
  principalRepo: ServicePrincipalSecretManagerRepo;
  auditor: McpAuditLogger;
  registry: CapabilityRegistry;
  serverName: string;
  serverVersion: string;
  oauthVerifier?: OAuthAccessTokenVerifier;
  resourceMetadataUrl?: string;
}

export function createMcpRoutes(deps: Deps): Router {
  const router = Router();

  const legacyAuth = requireServicePrincipal({
      repo: deps.principalRepo,
      auditor: deps.auditor,
      ...(deps.oauthVerifier !== undefined ? { oauthVerifier: deps.oauthVerifier } : {}),
      ...(deps.resourceMetadataUrl !== undefined
        ? { resourceMetadataUrl: deps.resourceMetadataUrl }
        : {}),
  });

  router.post(
    '/v1',
    // Porta do agente (spec 078, M2): a identidade já foi resolvida por `createAgentEntry` (header próprio). Só ela seta `req.agentPrincipal`.
    (req: Request, res: Response, next: NextFunction): void => (req.agentPrincipal ? next() : legacyAuth(req, res, next)),
    async (req: Request, res: Response): Promise<void> => {
      // Stateless: new Server + Transport instance per request
      const server = new McpServer({
        name: deps.serverName,
        version: deps.serverVersion,
      });

      deps.registry.registerAll(server, () => req.servicePrincipal, () => agentCallOf(req));

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session
        enableJsonResponse: true,
      });

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  // GET and DELETE not supported in stateless mode
  router.get('/v1', (_req: Request, res: Response): void => {
    res.status(405).json({ error: 'Method not allowed in stateless mode' });
  });

  router.delete('/v1', (_req: Request, res: Response): void => {
    res.status(405).json({ error: 'Method not allowed in stateless mode' });
  });

  return router;
}
