import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { AuthzActionError } from '@infrastructure/http/AdminAuthzApiService';
import { GroupSimulationSelect } from '../GroupSimulationSelect';

/**
 * F3/T3.1 (spec 026), decisão #2 do Gabriel: controle = `Select` de grupos +
 * botão de ícone (logout) ao lado, no rodapé da sidebar. Fica FORA de
 * `Gated`/`ContainerGate` — nunca importar esses aqui.
 *
 * CORREÇÃO DE TERRENO (L15, 23/09, decisão do Gabriel): este projeto é
 * Tailwind + lucide-react + átomos da casa — NÃO MUI, e nenhuma dependência
 * nova entra. Ajuste MÍNIMO neste arquivo (era RED com MUI presumido):
 *  - `Select` é o átomo `@presentation/components/atoms/Select` — um
 *    `<select>` NATIVO (role `combobox`, todas as `<option>` já no DOM, sem
 *    popup/portal). Escolher opção é `userEvent.selectOptions`, não
 *    click+click.
 *  - Sem átomo de Tooltip na casa (`ls atoms molecules | grep -i tooltip` →
 *    vazio): o estado desabilitado usa o atributo `title` nativo do HTML no
 *    wrapper, testável direto (sem hover), em vez de `role="tooltip"`.
 *
 * Decisões de desenho fixadas por este teste (T3.2/T3.3 seguem):
 *  - Sem props: o componente lê `authz`/`simulationExpired` e as ações
 *    (`startSimulation`, `endSimulation`, `listSimulatableGroups`) direto do
 *    `useAdminAuthStore` — mesmo padrão de outros componentes de access que
 *    não recebem authz por prop (ContainerGate).
 *  - `Select` com accessible name = chave i18n `access.simulation.select`
 *    (via `aria-label`), role `combobox` (nativo).
 *  - Opções = `{id,name}` de `listSimulatableGroups()`, chamado uma vez ao
 *    montar; o texto visível da opção é `name`, o `value` é `id`.
 *  - Escolher uma opção chama `startSimulation(id)`.
 *  - `enforcement !== 'on'` (inclusive ausente): `Select` desabilitado,
 *    envolto por um wrapper com `data-testid="group-simulation-select-disabled-wrapper"`
 *    que carrega `title` com a chave `access.simulation.disabledEngineOff`.
 *  - Botão de sair só existe com `authz.simulation !== null`; aria-label
 *    = chave `access.simulation.exit`; clicar chama `endSimulation()`.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
  }),
}));

const GRUPOS = [
  { id: 'g-recl', name: 'Reclutamiento - AG' },
  { id: 'g-fin', name: 'Finanzas - AG' },
];

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

interface MontarOver {
  authz?: AuthzContract | null;
  startSimulation?: ReturnType<typeof vi.fn>;
  endSimulation?: ReturnType<typeof vi.fn>;
  listSimulatableGroups?: ReturnType<typeof vi.fn>;
}

function montarStore(over: MontarOver = {}): {
  startSimulation: ReturnType<typeof vi.fn>;
  endSimulation: ReturnType<typeof vi.fn>;
  listSimulatableGroups: ReturnType<typeof vi.fn>;
} {
  const startSimulation = over.startSimulation ?? vi.fn().mockResolvedValue(undefined);
  const endSimulation = over.endSimulation ?? vi.fn().mockResolvedValue(undefined);
  const listSimulatableGroups = over.listSimulatableGroups ?? vi.fn().mockResolvedValue(GRUPOS);
  useAdminAuthStore.setState({
    authz: over.authz === undefined ? contrato() : over.authz,
    authzStatus: 'ready',
    startSimulation,
    endSimulation,
    listSimulatableGroups,
  } as never);
  return { startSimulation, endSimulation, listSimulatableGroups };
}

describe('GroupSimulationSelect (F3/T3.1 RED, decisão #2)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle', switching: null, switchError: null } as never);
  });

  it('não renderiza nada quando authz.canSimulate === false', () => {
    montarStore({ authz: contrato({ canSimulate: false }) });
    const { container } = render(<GroupSimulationSelect />);
    expect(container).toBeEmptyDOMElement();
  });

  it('não renderiza nada quando authz é null', () => {
    montarStore({ authz: null });
    const { container } = render(<GroupSimulationSelect />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renderiza o Select habilitado (label = access.simulation.select) com as opções de listSimulatableGroups, quando canSimulate=true e enforcement=on', async () => {
    const { listSimulatableGroups } = montarStore();
    render(<GroupSimulationSelect />);

    const select = screen.getByRole('combobox', { name: 'access.simulation.select' });
    expect(select).toBeEnabled();
    await waitFor(() => expect(listSimulatableGroups).toHaveBeenCalledTimes(1));

    // `<select>` nativo: as opções já estão no DOM, sem precisar "abrir" nada.
    expect(await screen.findByRole('option', { name: 'Reclutamiento - AG' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Finanzas - AG' })).toBeInTheDocument();
  });

  it('enforcement !== "on": Select desabilitado, com title (tooltip nativo) mostrando access.simulation.disabledEngineOff', async () => {
    const { listSimulatableGroups } = montarStore({ authz: contrato({ enforcement: 'off' }) });
    render(<GroupSimulationSelect />);

    const select = screen.getByRole('combobox', { name: 'access.simulation.select' });
    expect(select).toBeDisabled();

    const wrapper = screen.getByTestId('group-simulation-select-disabled-wrapper');
    expect(wrapper).toHaveAttribute('title', 'access.simulation.disabledEngineOff');
    await waitFor(() => expect(listSimulatableGroups).toHaveBeenCalledTimes(1));
  });

  it('enforcement ausente (contrato de transição, D268): mesmo tratamento — Select desabilitado', async () => {
    const semEnforcement = contrato();
    delete (semEnforcement as { enforcement?: AuthzContract['enforcement'] }).enforcement;
    const { listSimulatableGroups } = montarStore({ authz: semEnforcement });
    render(<GroupSimulationSelect />);
    expect(screen.getByRole('combobox', { name: 'access.simulation.select' })).toBeDisabled();
    await waitFor(() => expect(listSimulatableGroups).toHaveBeenCalledTimes(1));
  });

  it('sem simulação ativa: o IconButton de sair não existe', async () => {
    const { listSimulatableGroups } = montarStore({ authz: contrato({ simulation: null }) });
    render(<GroupSimulationSelect />);
    expect(screen.queryByRole('button', { name: 'access.simulation.exit' })).not.toBeInTheDocument();
    await waitFor(() => expect(listSimulatableGroups).toHaveBeenCalledTimes(1));
  });

  it('com simulação ativa: o IconButton de sair aparece, e clicar chama endSimulation()', async () => {
    const { endSimulation } = montarStore({ authz: contrato({ simulation: SIMULACAO }) });
    render(<GroupSimulationSelect />);
    await screen.findByRole('option', { name: 'Reclutamiento - AG' });

    const sair = screen.getByRole('button', { name: 'access.simulation.exit' });
    await userEvent.click(sair);

    expect(endSimulation).toHaveBeenCalledTimes(1);
  });

  it('escolher uma opção chama startSimulation(groupId, groupName) — F2: o nome alimenta o overlay de troca', async () => {
    const { startSimulation } = montarStore();
    render(<GroupSimulationSelect />);

    const select = screen.getByRole('combobox', { name: 'access.simulation.select' });
    await screen.findByRole('option', { name: 'Finanzas - AG' }); // espera o fetch de listSimulatableGroups popular as opções
    await userEvent.selectOptions(select, 'g-fin');

    await waitFor(() => expect(startSimulation).toHaveBeenCalledWith('g-fin', 'Finanzas - AG'));
  });

  it('nenhum texto cru em espanhol — só as chaves i18n fechadas (select, exit, disabledEngineOff)', async () => {
    const { listSimulatableGroups } = montarStore({ authz: contrato({ enforcement: 'off', simulation: SIMULACAO }) });
    const { container } = render(<GroupSimulationSelect />);

    expect(container).toHaveTextContent(/access\.simulation\.(select|exit)/);
    const wrapper = screen.getByTestId('group-simulation-select-disabled-wrapper');
    expect(wrapper).toHaveAttribute('title', 'access.simulation.disabledEngineOff');
    expect(container.textContent).not.toMatch(/simular grupo|cerrar sesión|grupo de acceso/i);
    await waitFor(() => expect(listSimulatableGroups).toHaveBeenCalledTimes(1));
  });

  it('cobertura T3.7: selecionar o placeholder (value vazio) não chama startSimulation', async () => {
    const { startSimulation } = montarStore();
    render(<GroupSimulationSelect />);

    const select = screen.getByRole('combobox', { name: 'access.simulation.select' });
    await screen.findByRole('option', { name: 'Finanzas - AG' });
    await userEvent.selectOptions(select, '');

    expect(startSimulation).not.toHaveBeenCalled();
  });

  it('cobertura T3.7: listSimulatableGroups() rejeitando não quebra — grupos ficam vazios (sem opções além do placeholder)', async () => {
    const listSimulatableGroups = vi.fn().mockRejectedValue(new Error('rede caiu'));
    montarStore({ listSimulatableGroups });
    render(<GroupSimulationSelect />);

    await waitFor(() => expect(listSimulatableGroups).toHaveBeenCalledTimes(1));
    // só o placeholder — nenhuma opção de grupo populada.
    expect(screen.queryAllByRole('option')).toHaveLength(1);
  });

  it('cobertura T3.7: startSimulation rejeitando com AuthzActionError("group_not_simulable") mostra o texto inline pela chave certa', async () => {
    const startSimulation = vi.fn().mockRejectedValue(new AuthzActionError('group_not_simulable'));
    montarStore({ startSimulation });
    render(<GroupSimulationSelect />);

    const select = screen.getByRole('combobox', { name: 'access.simulation.select' });
    await screen.findByRole('option', { name: 'Finanzas - AG' });
    await userEvent.selectOptions(select, 'g-fin');

    expect(await screen.findByText('access.simulation.groupNotSimulable')).toBeInTheDocument();
  });

  it('F2: switching !== null desabilita o Select, mesmo com enforcement=on', async () => {
    const { listSimulatableGroups } = montarStore();
    useAdminAuthStore.setState({ switching: { kind: 'start', groupId: 'g-recl', groupName: 'Reclutamiento - AG' } } as never);
    render(<GroupSimulationSelect />);

    expect(screen.getByRole('combobox', { name: 'access.simulation.select' })).toBeDisabled();
    await waitFor(() => expect(listSimulatableGroups).toHaveBeenCalledTimes(1));
  });

  it('cobertura T3.7: startSimulation rejeitando com erro genérico (sem code) não mostra o texto de groupNotSimulable', async () => {
    const startSimulation = vi.fn().mockRejectedValue(new Error('boom'));
    montarStore({ startSimulation });
    render(<GroupSimulationSelect />);

    const select = screen.getByRole('combobox', { name: 'access.simulation.select' });
    await screen.findByRole('option', { name: 'Finanzas - AG' });
    await userEvent.selectOptions(select, 'g-fin');

    await waitFor(() => expect(startSimulation).toHaveBeenCalledWith('g-fin', 'Finanzas - AG'));
    expect(screen.queryByText('access.simulation.groupNotSimulable')).not.toBeInTheDocument();
  });
});
