import type { AuthContext } from '../modules/identity/domain/Auth';
import type { ServicePrincipal } from '../modules/mcp/domain/ServicePrincipal';

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
      authContext?: AuthContext;
      user?: {
        uid: string;
        email?: string;
        role?: string;
        roles?: string[];
        type?: string;
        /** Jurisdição do operador (claim `country`) — ABAC país Fase 1. */
        country?: string;
      };
      servicePrincipal?: ServicePrincipal;
      onBehalfOfWorkerId?: string;
    }
  }
}

export {};
