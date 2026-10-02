/**
 * isPermissionFamilyEnforced — a MESMA regra de "esta família está sob decisão real do ABAC
 * hoje?" que antes só existia como método PRIVADO (`PermissionMiddleware.isFamilyEnforced`,
 * F22 de `fatos-medidos.md` da change 022-ux-mencao-e-notificacao). Extraída para ser reusada
 * fora do middleware HTTP — primeiro consumidor: `PermissionClientActorAccessChecker` (item 5b,
 * achado F24: o gate de LEITURA do nome do paciente numa notificação checava só o grant CRU do
 * catálogo, ignorando as duas alavancas de rollout — mais restritivo que o acesso real à
 * conversa quando a família não está enforced, ex.: `PERMISSION_ENGINE_ENABLED=false` em prd).
 *
 * Combina as DUAS alavancas do rollout (design 6 do módulo, `PermissionMiddleware.ts`): o
 * engine geral E a família específica na lista — nenhuma das duas sozinha decide. Comportamento
 * IDÊNTICO ao que `PermissionMiddleware.buildGuard` já fazia em duas checagens separadas
 * (`isEnvFlagOn('PERMISSION_ENGINE_ENABLED', ...)` seguido de `isFamilyEnforced(family)`) — esta
 * extração não muda nenhuma resposta HTTP, só reusa o predicado.
 */
import { isEnvFlagOn } from '@shared/utils/envFlag';
import { parseEnvList } from '@shared/utils/envList';

export function isPermissionFamilyEnforced(family: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagOn('PERMISSION_ENGINE_ENABLED', env) && parseEnvList(env.PERMISSION_ENFORCED_ROUTES).includes(family);
}
