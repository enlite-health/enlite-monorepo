import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { GroupSimulationOverlay } from '../App';

/**
 * F3/T3.4 (spec 026) — prova que o overlay de simulação (banner + o Select de
 * "sair" quando aplicável) monta acima de `AdminProtectedRoute` mesmo na
 * História 2: grupo simulado com ZERO células (`groups: []`), que faz
 * `shouldShowWelcomeNoGroup` virar `true` e `AdminProtectedRoute` trocar todo
 * o `children` (incluindo o `AppSidebar`, onde vive o rodapé) pela
 * `WelcomeNoGroupPage`. Sem este overlay, quem está simulando esse grupo
 * ficaria preso na tela "sem grupo" sem controle nenhum para sair.
 *
 * Testamos `GroupSimulationOverlay` isoladamente (exportado de `App.tsx`, no
 * mesmo padrão de `VacancyEnAliasRedirect` já testado à parte em
 * `VacancyEnAliasRedirect.test.tsx`) em vez de montar o `<App />` inteiro —
 * o `<App />` completo arrasta Firebase/lazy chunks/BrowserRouter reais, que
 * não são o que esta prova precisa.
 */

// Importar `../App` arrasta `src/infrastructure/i18n/config.ts` (efeito de
// módulo de alguma página estática do App.tsx), que chama
// `i18n.use(initReactI18next)` — sem este export o mock quebra ESSE init
// real, não o nosso `useTranslation`. `initReactI18next` é só o plugin de
// integração; o `i18next` core que ele registra continua real e inofensivo.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
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
    groups: [{ id: 'g0', name: 'Grupo qualquer' }],
    features: {},
    enforcement: 'on',
    canSimulate: true,
    simulation: null,
    ...over,
  }) as AuthzContract;

describe('GroupSimulationOverlay (App.tsx, T3.4)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({
      authz: null,
      authzStatus: 'idle',
      simulationExpired: false,
      startSimulation: vi.fn().mockResolvedValue(undefined),
      endSimulation: vi.fn().mockResolvedValue(undefined),
      dismissSimulationExpired: vi.fn(),
      listSimulatableGroups: vi.fn().mockResolvedValue([]),
    } as never);
  });

  it('🔴 renderiza o banner com authz.simulation mesmo quando groups=[] e enforcement=on (História 2)', () => {
    useAdminAuthStore.setState({
      authz: contrato({ groups: [], simulation: SIMULACAO }),
      authzStatus: 'ready',
    });

    render(<GroupSimulationOverlay />);

    expect(screen.getByTestId('group-simulation-banner')).toHaveTextContent(
      'access.simulation.viewingAs:{"group":"Reclutamiento - AG"}',
    );
  });

  it('🔴 groups=[] + enforcement=on (shouldShowWelcomeNoGroup=true): monta TAMBÉM o Select/sair, não só o banner', async () => {
    useAdminAuthStore.setState({
      authz: contrato({ groups: [], simulation: SIMULACAO }),
      authzStatus: 'ready',
    });

    render(<GroupSimulationOverlay />);

    expect(screen.getByTestId('group-simulation-select-welcome-overlay')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'access.simulation.exit' })).toBeInTheDocument();
    await waitFor(() => expect(useAdminAuthStore.getState().listSimulatableGroups).toHaveBeenCalled());
  });

  it('com grupo (groups não vazio): NÃO monta o overlay extra de Select — o rodapé normal já cobre', () => {
    useAdminAuthStore.setState({
      authz: contrato({ groups: [{ id: 'g0', name: 'Grupo qualquer' }], simulation: SIMULACAO }),
      authzStatus: 'ready',
    });

    render(<GroupSimulationOverlay />);

    expect(screen.queryByTestId('group-simulation-select-welcome-overlay')).not.toBeInTheDocument();
    // o banner continua aparecendo — ele é incondicional à tela
    expect(screen.getByTestId('group-simulation-banner')).toBeInTheDocument();
  });

  it('sem simulação e sem expirado: nada renderiza (nem banner, nem overlay de select)', () => {
    useAdminAuthStore.setState({ authz: contrato(), authzStatus: 'ready' });

    const { container } = render(<GroupSimulationOverlay />);

    expect(screen.queryByTestId('group-simulation-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-simulation-select-welcome-overlay')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
