import { ACCOUNT_POLICIES } from './account';
import { WORKER_POLICIES } from './worker';

export { CLIENT_SCHEMA } from './schema';
/** Todas as políticas estáticas do plano do cliente. Sem `permit` = deny. */
export const CLIENT_POLICIES = [WORKER_POLICIES, ACCOUNT_POLICIES].join('\n');
