import type { AuthContext } from '../modules/identity/domain/Auth';

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
      };
    }
  }
}

export {};
