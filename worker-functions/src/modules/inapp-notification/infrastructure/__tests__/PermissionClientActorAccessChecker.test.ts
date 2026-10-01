/**
 * PermissionClientActorAccessChecker — TDD (change 022-ux-mencao-e-notificacao, item 5b, F24).
 *
 * Achado F24 (`fatos-medidos.md`): em prd, `PERMISSION_ENGINE_ENABLED=false`
 * (`.github/workflows/backend-prd.yml:118`) — a rota REAL da conversa (`PermissionMiddleware`)
 * deixa passar QUALQUER staff autenticado nesse modo (F22). Mas `canReadPatientConversation`
 * fazia só a leitura CRUA do catálogo (F23), sem olhar as alavancas de rollout — mais restritivo
 * que o acesso real, causando "um paciente" mesmo para quem já vê a conversa de verdade.
 *
 * Fase 1, tarefa 1.7: os 4 quadrantes (engine on/off × família admin.patients enforced sim/não)
 * MAIS o caso de grant real (sempre `true`, nunca regride quando enforced).
 */
import { PermissionClientActorAccessChecker } from '../PermissionClientActorAccessChecker';
import type { PermissionClient } from '@modules/identity/permissions';

function clientStub(can: jest.Mock): PermissionClient {
  return { can, resolve: jest.fn(), isFeatureAvailable: jest.fn(), featureConfig: jest.fn(), invalidate: jest.fn() } as unknown as PermissionClient;
}

describe('PermissionClientActorAccessChecker.canReadPatientConversation — 4 quadrantes + grant real', () => {
  it('engine OFF, família FORA do enforced: true SEM checar o catálogo (mesmo efeito de "todo staff passa" da rota real, F22)', async () => {
    const can = jest.fn();
    const checker = new PermissionClientActorAccessChecker(clientStub(can), 'tenant', {
      PERMISSION_ENGINE_ENABLED: 'false',
      PERMISSION_ENFORCED_ROUTES: '',
    });

    await expect(checker.canReadPatientConversation('uid-1')).resolves.toBe(true);
    expect(can).not.toHaveBeenCalled();
  });

  it('engine OFF, família NA lista (irrelevante — engine geral já desliga tudo): true sem checar catálogo', async () => {
    const can = jest.fn();
    const checker = new PermissionClientActorAccessChecker(clientStub(can), 'tenant', {
      PERMISSION_ENGINE_ENABLED: 'false',
      PERMISSION_ENFORCED_ROUTES: 'admin.patients',
    });

    await expect(checker.canReadPatientConversation('uid-1')).resolves.toBe(true);
    expect(can).not.toHaveBeenCalled();
  });

  it('engine ON, família FORA do enforced: true sem checar catálogo (família ainda não virou)', async () => {
    const can = jest.fn();
    const checker = new PermissionClientActorAccessChecker(clientStub(can), 'tenant', {
      PERMISSION_ENGINE_ENABLED: 'true',
      PERMISSION_ENFORCED_ROUTES: 'admin.users',
    });

    await expect(checker.canReadPatientConversation('uid-1')).resolves.toBe(true);
    expect(can).not.toHaveBeenCalled();
  });

  it('engine ON, família ENFORCED: comportamento ATUAL — decide pelo grant real do catálogo (F23, sem mudança)', async () => {
    const can = jest.fn().mockResolvedValue(false);
    const checker = new PermissionClientActorAccessChecker(clientStub(can), 'tenant', {
      PERMISSION_ENGINE_ENABLED: 'true',
      PERMISSION_ENFORCED_ROUTES: 'admin.patients',
    });

    await expect(checker.canReadPatientConversation('uid-1')).resolves.toBe(false);
    expect(can).toHaveBeenCalledWith('uid-1', 'tenant', 'patient_conversation', 'read');
  });

  it('família ENFORCED com grant real TRUE: sempre true, nunca regride', async () => {
    const can = jest.fn().mockResolvedValue(true);
    const checker = new PermissionClientActorAccessChecker(clientStub(can), 'tenant', {
      PERMISSION_ENGINE_ENABLED: 'true',
      PERMISSION_ENFORCED_ROUTES: 'admin.patients',
    });

    await expect(checker.canReadPatientConversation('uid-1')).resolves.toBe(true);
  });

  it('sem `env` injetado, usa process.env (wiring de produção não injeta)', async () => {
    const anterior = { engine: process.env.PERMISSION_ENGINE_ENABLED, rotas: process.env.PERMISSION_ENFORCED_ROUTES };
    process.env.PERMISSION_ENGINE_ENABLED = 'false';
    process.env.PERMISSION_ENFORCED_ROUTES = '';
    try {
      const can = jest.fn();
      const checker = new PermissionClientActorAccessChecker(clientStub(can));
      await expect(checker.canReadPatientConversation('uid-1')).resolves.toBe(true);
      expect(can).not.toHaveBeenCalled();
    } finally {
      if (anterior.engine === undefined) delete process.env.PERMISSION_ENGINE_ENABLED; else process.env.PERMISSION_ENGINE_ENABLED = anterior.engine;
      if (anterior.rotas === undefined) delete process.env.PERMISSION_ENFORCED_ROUTES; else process.env.PERMISSION_ENFORCED_ROUTES = anterior.rotas;
    }
  });
});
