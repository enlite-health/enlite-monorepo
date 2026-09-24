import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { GroupSwitchOverlay } from '../GroupSwitchOverlay';

/**
 * F2 (spec 026, `troca-de-grupo-simulado-com-feedback-e-cache-versionado`) —
 * overlay de tela cheia SÓ RENDERIZA o que a store decide (`switching`/
 * `switchError`) — sem lógica própria. Molde: `GroupSimulationBanner.test.tsx`
 * (mesmo mock de `react-i18next`, mesmo padrão de reset via `setState`).
 *
 * Decisões de desenho fixadas por este teste:
 *  - `null`/`null` (nenhuma troca em curso, sem erro): DOM vazio.
 *  - `switching.kind==='start'`: `role="status"`, `aria-busy="true"`, texto
 *    `access.simulation.switchingTo` com o `groupName`.
 *  - `switching.kind==='end'`: texto `access.simulation.switchingBack`.
 *  - `switchError==='unconfirmed'`: `aria-busy="false"` (sem spinner), texto
 *    `access.simulation.switchUnconfirmed` + botão `data-testid="group-switch-retry"`
 *    que chama `dismissSwitchError()`.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
  }),
}));

describe('GroupSwitchOverlay (F2)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ switching: null, switchError: null } as never);
  });

  it('nenhuma troca em curso e sem erro: não renderiza nada', () => {
    const { container } = render(<GroupSwitchOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('switching.kind === "start": role=status, aria-busy=true, mostra o nome do grupo', () => {
    useAdminAuthStore.setState({
      switching: { kind: 'start', groupId: 'g-recl', groupName: 'Reclutamiento - AG' },
      switchError: null,
    } as never);
    render(<GroupSwitchOverlay />);

    const overlay = screen.getByTestId('group-switch-overlay');
    expect(overlay).toHaveAttribute('role', 'status');
    expect(overlay).toHaveAttribute('aria-busy', 'true');
    expect(overlay).toHaveTextContent(
      'access.simulation.switchingTo:{"group":"Reclutamiento - AG"}',
    );
  });

  it('switching.kind === "end": mostra o texto de volta ao acesso habitual', () => {
    useAdminAuthStore.setState({ switching: { kind: 'end' }, switchError: null } as never);
    render(<GroupSwitchOverlay />);

    expect(screen.getByTestId('group-switch-overlay')).toHaveTextContent('access.simulation.switchingBack');
  });

  it('switchError === "unconfirmed": aria-busy=false, texto de erro + botão Reintentar que chama dismissSwitchError', async () => {
    const dismissSwitchError = vi.fn();
    useAdminAuthStore.setState({ switching: null, switchError: 'unconfirmed', dismissSwitchError } as never);
    render(<GroupSwitchOverlay />);

    const overlay = screen.getByTestId('group-switch-overlay');
    expect(overlay).toHaveAttribute('aria-busy', 'false');
    expect(overlay).toHaveTextContent('access.simulation.switchUnconfirmed');

    const retry = screen.getByTestId('group-switch-retry');
    await userEvent.click(retry);

    expect(dismissSwitchError).toHaveBeenCalledTimes(1);
  });
});
