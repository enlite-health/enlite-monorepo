/**
 * isPermissionFamilyEnforced — TDD (change 022-ux-mencao-e-notificacao, item 5b, F22/F24).
 *
 * Extrai a regra que antes só existia como `PermissionMiddleware.isFamilyEnforced` (privado) +
 * o `isEnvFlagOn('PERMISSION_ENGINE_ENABLED')` que o `buildGuard` checava ANTES dela — as DUAS
 * alavancas do rollout (design 6), combinadas num único predicado reusável fora do middleware
 * HTTP. Primeiro consumidor fora do middleware: `PermissionClientActorAccessChecker`.
 */
import { isPermissionFamilyEnforced } from '../permissionFamilyEnforcement';

describe('isPermissionFamilyEnforced — combina engine + família na lista', () => {
  it('engine OFF, família NA lista: false (engine desligado nunca enforça nada, F22)', () => {
    const env = { PERMISSION_ENGINE_ENABLED: 'false', PERMISSION_ENFORCED_ROUTES: 'admin.patients' };
    expect(isPermissionFamilyEnforced('admin.patients', env)).toBe(false);
  });

  it('engine ON, família FORA da lista: false', () => {
    const env = { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.users' };
    expect(isPermissionFamilyEnforced('admin.patients', env)).toBe(false);
  });

  it('engine ON, família NA lista: true', () => {
    const env = { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.users;admin.patients' };
    expect(isPermissionFamilyEnforced('admin.patients', env)).toBe(true);
  });

  it('engine OFF, família FORA da lista: false (as duas faltando não é "mais false" que uma só)', () => {
    const env = { PERMISSION_ENGINE_ENABLED: 'false', PERMISSION_ENFORCED_ROUTES: 'admin.users' };
    expect(isPermissionFamilyEnforced('admin.patients', env)).toBe(false);
  });

  it('sem nenhuma env setada: false (default seguro, nunca enforced por omissão)', () => {
    expect(isPermissionFamilyEnforced('admin.patients', {})).toBe(false);
  });

  it('env não injetada: usa process.env (default do parâmetro)', () => {
    const anterior = { engine: process.env.PERMISSION_ENGINE_ENABLED, rotas: process.env.PERMISSION_ENFORCED_ROUTES };
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    process.env.PERMISSION_ENFORCED_ROUTES = 'admin.patients';
    try {
      expect(isPermissionFamilyEnforced('admin.patients')).toBe(true);
    } finally {
      if (anterior.engine === undefined) delete process.env.PERMISSION_ENGINE_ENABLED; else process.env.PERMISSION_ENGINE_ENABLED = anterior.engine;
      if (anterior.rotas === undefined) delete process.env.PERMISSION_ENFORCED_ROUTES; else process.env.PERMISSION_ENFORCED_ROUTES = anterior.rotas;
    }
  });
});
