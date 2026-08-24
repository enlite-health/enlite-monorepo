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
      /**
       * Células do ator, resolvidas pelo `PermissionMiddleware` (F2/C3).
       *
       * ⚠️ `undefined` NÃO é "sem célula": é "o engine não decidiu nesta
       * request" — família fora de `PERMISSION_ENFORCED_ROUTES`, principal de
       * serviço, engine desligado. `projectWorkerFields` recebe `null` nesse
       * caso e devolve o que a rota devolvia antes (D113: engine desligado não
       * muda comportamento). Array VAZIO é ator conhecido e sem nenhuma célula,
       * e aí a redação vale. Confundir os dois nega tudo para todo mundo no flip.
       */
      permissionCells?: string[];
      servicePrincipal?: ServicePrincipal;
      onBehalfOfWorkerId?: string;
    }
  }
}

export {};
