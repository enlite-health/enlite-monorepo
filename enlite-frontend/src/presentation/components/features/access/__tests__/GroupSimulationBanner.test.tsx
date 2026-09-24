import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { GroupSimulationBanner } from '../GroupSimulationBanner';

/**
 * F3/T3.1 (spec 026), decisão #2 do Gabriel: o banner é SÓ sinal visual —
 * nenhum controle (nem Select, nem botão de sair). Sem os wrappers de célula
 * ABAC do módulo de acesso — nunca importar esses aqui.
 *
 * Decisões de desenho fixadas por este teste:
 *  - Sem props: lê `authz.simulation` e `simulationExpired` do
 *    `useAdminAuthStore`, mais a ação `dismissSimulationExpired`.
 *  - Com simulação ativa: chama `t('access.simulation.viewingAs', { group: <groupName> })`.
 *  - Sem simulação e `simulationExpired === true`: `role="alert"` com o texto
 *    da chave `access.simulation.expired`; botão de fechar com
 *    `data-testid="group-simulation-expired-dismiss"` chama `dismissSimulationExpired()`.
 *  - Sem simulação e sem expirado: não renderiza nada (DOM vazio).
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
  }),
}));

const SIMULACAO = {
  id: 's1',
  groupId: 'g-recl',
  groupName: 'Reclutamiento - AG',
  startedAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2026-09-23T14:00:00.000Z',
};

const contrato = (over: Partial<AuthzContract> = {}): AuthzContract =>
  ({
    uid: 'u',
    tenantId: 't',
    status: 'ACTIVE',
    permissions: [],
    countries: ['AR'],
    groups: [],
    features: {},
    enforcement: 'on',
    canSimulate: true,
    simulation: null,
    ...over,
  }) as AuthzContract;

describe('GroupSimulationBanner (F3/T3.1 RED, decisão #2)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({
      authz: null,
      authzStatus: 'idle',
      simulationExpired: false,
      dismissSimulationExpired: vi.fn(),
    } as never);
  });

  it('com simulação ativa: mostra access.simulation.viewingAs interpolado com o nome do grupo', () => {
    useAdminAuthStore.setState({
      authz: contrato({ simulation: SIMULACAO }),
      authzStatus: 'ready',
      simulationExpired: false,
    } as never);

    render(<GroupSimulationBanner />);

    expect(screen.getByText('access.simulation.viewingAs:{"group":"Reclutamiento - AG"}')).toBeInTheDocument();
  });

  it('sem simulação e simulationExpired=true: mostra access.simulation.expired num alert, e o botão de fechar chama dismissSimulationExpired', async () => {
    const dismissSimulationExpired = vi.fn();
    useAdminAuthStore.setState({
      authz: contrato({ simulation: null }),
      authzStatus: 'ready',
      simulationExpired: true,
      dismissSimulationExpired,
    } as never);

    render(<GroupSimulationBanner />);

    const alerta = screen.getByRole('alert');
    expect(alerta).toHaveTextContent('access.simulation.expired');

    await userEvent.click(screen.getByTestId('group-simulation-expired-dismiss'));
    expect(dismissSimulationExpired).toHaveBeenCalledTimes(1);
  });

  it('sem simulação e sem expirado: não renderiza nada', () => {
    useAdminAuthStore.setState({
      authz: contrato({ simulation: null }),
      authzStatus: 'ready',
      simulationExpired: false,
    } as never);

    const { container } = render(<GroupSimulationBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('🔒 o banner NÃO tem botão de sair — decisão #2, só sinal visual, o controle mora no GroupSimulationSelect', () => {
    useAdminAuthStore.setState({
      authz: contrato({ simulation: SIMULACAO }),
      authzStatus: 'ready',
      simulationExpired: false,
    } as never);

    render(<GroupSimulationBanner />);

    expect(screen.queryByRole('button', { name: 'access.simulation.exit' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-simulation-expired-dismiss')).not.toBeInTheDocument();
  });
});
