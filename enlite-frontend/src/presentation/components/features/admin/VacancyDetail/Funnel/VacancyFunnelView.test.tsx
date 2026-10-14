import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFunnelView } from './VacancyFunnelView';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { FunnelTableData, FunnelTableRow } from '@domain/entities/Funnel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

const mockUseVacancyFunnelTable = vi.fn();
vi.mock('@hooks/admin/useVacancyFunnelTable', () => ({
  useVacancyFunnelTable: (...args: unknown[]) =>
    mockUseVacancyFunnelTable(...args),
}));

vi.mock('@hooks/admin/useInvitedPendingCandidates', () => ({
  useInvitedPendingCandidates: () => ({
    candidates: [],
    pendingCount: 3,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('./VacancyFunnelKanban', () => ({
  VacancyFunnelKanban: ({ vacancyId }: { vacancyId: string }) => (
    <div data-testid="kanban-board">{vacancyId}</div>
  ),
}));

vi.mock('./VacancyFunnelTable', () => ({
  VacancyFunnelTable: ({
    rows,
    isFiltered,
  }: {
    rows: { id: string }[];
    isFiltered?: boolean;
  }) => (
    <div data-testid="funnel-table" data-filtered={String(!!isFiltered)}>
      {rows.map((r) => (
        <span key={r.id} data-testid="mock-row">
          {r.id}
        </span>
      ))}
    </div>
  ),
}));

function frow(id: string, workerName: string, registrationComplete: boolean): FunnelTableRow {
  return {
    id, workerId: `w-${id}`, workerName, workerEmail: null, workerPhone: null,
    workerAvatarUrl: null, invitedAt: '2026-01-15T00:00:00.000Z', funnelStage: 'INVITED',
    whatsappStatus: null, whatsappLastDispatchedAt: null, accepted: null,
    interviewResponse: null, registrationComplete, contactNotesCount: 0,
    kanbanColumn: 'INVITED', isBlocked: false,
  };
}

const mockData: FunnelTableData = {
  rows: [],
  counts: {
    INVITED: 0,
    POSTULATED: 0,
    PRE_SELECTED: 0,
    REJECTED: 0,
    WITHDREW: 0,
    ALL: 0,
    columns: {},
  },
};

beforeEach(() => {
  // Reset calls entre tests pra evitar flakiness — sem isso, mock.calls acumula
  // chamadas dos testes anteriores e lastCall pode pegar invocação de outro test.
  mockUseVacancyFunnelTable.mockClear();
  mockUseVacancyFunnelTable.mockReturnValue({
    data: mockData,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  // Clear localStorage between tests
  localStorage.clear();
});

const KANBAN_BTN = 'admin.vacancyDetail.funnelView.viewToggle.kanban';
const LIST_BTN = 'admin.vacancyDetail.funnelView.viewToggle.list';
const OLD_KEY = 'vacancy-funnel-view-vac-1';
const NEW_KEY = 'vacancy-funnel-view-v2-vac-1';

// O Toggle é o REAL: o que se prova aqui é o botão que a pessoa vê/aperta.
const kanbanBtn = () => screen.getByRole('button', { name: KANBAN_BTN });
const listBtn = () => screen.getByRole('button', { name: LIST_BTN });

describe('VacancyFunnelView', () => {
  it('abre no Kanban por padrão (054 item 5): botão Kanban pressionado, Lista não montada', () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    expect(kanbanBtn()).toHaveAttribute('aria-pressed', 'true');
    expect(listBtn()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    expect(screen.queryByTestId('funnel-table')).not.toBeInTheDocument();
  });

  it('chave ANTIGA = "list" e nada na nova: abre no Kanban (a chave antiga não é lida)', () => {
    localStorage.setItem(OLD_KEY, 'list');
    render(<VacancyFunnelView vacancyId="vac-1" />);
    expect(kanbanBtn()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    expect(screen.queryByTestId('funnel-table')).not.toBeInTheDocument();
  });

  it('escolher Lista grava "list" na chave v2 e, ao remontar, abre na Lista', async () => {
    const { unmount } = render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    expect(localStorage.getItem(NEW_KEY)).toBe('list');
    expect(localStorage.getItem(OLD_KEY)).toBeNull();
    unmount();
    render(<VacancyFunnelView vacancyId="vac-1" />);
    expect(listBtn()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('funnel-table')).toBeInTheDocument();
  });

  it('o primeiro botão do grupo "Cambiar vista" é o Kanban', () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    const [first, second] = within(screen.getByRole('group')).getAllByRole('button');
    expect(first).toHaveAccessibleName(KANBAN_BTN);
    expect(second).toHaveAccessibleName(LIST_BTN);
  });

  it('renders the table in list view', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    expect(screen.getByTestId('funnel-table')).toBeInTheDocument();
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
  });

  it('switches to kanban when kanban button is clicked', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    await userEvent.click(kanbanBtn());
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    expect(screen.queryByTestId('funnel-table')).not.toBeInTheDocument();
  });

  it('switches back to list from kanban', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    expect(screen.getByTestId('funnel-table')).toBeInTheDocument();
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
  });

  it('passes vacancyId to KanbanBoard when in kanban view', () => {
    render(<VacancyFunnelView vacancyId="vac-42" />);
    expect(screen.getByTestId('kanban-board')).toHaveTextContent('vac-42');
  });

  it('does not call useVacancyFunnelTable with enabled=true in kanban view', () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    const lastCall =
      mockUseVacancyFunnelTable.mock.calls[
        mockUseVacancyFunnelTable.mock.calls.length - 1
      ];
    expect(lastCall[2]).toBe(false);
  });

  it('a Lista não tem abas: nenhum role="tab", funnel-tab-* nem funnel-panel-* (054 item 1)', async () => {
    const { container } = render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('tabpanel')).toHaveLength(0);
    expect(container.querySelector('[data-testid^="funnel-tab-"]')).toBeNull();
    expect(container.querySelector('[data-testid^="funnel-panel-"]')).toBeNull();
  });

  it('a Lista pede TODAS as colunas do Kanban (as 9 sources), não bucket=ALL', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    const lastCall =
      mockUseVacancyFunnelTable.mock.calls[
        mockUseVacancyFunnelTable.mock.calls.length - 1
      ];
    const tabArg = lastCall[1] as { kind: string; column: { sources: string[] } };
    expect(tabArg.kind).toBe('column');
    expect([...tabArg.column.sources].sort()).toEqual(
      [
        'COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS',
        'COMPLETED', 'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED',
      ].sort(),
    );
    expect(lastCall[2]).toBe(true);
  });

  it('digitar na busca reduz as linhas passadas à tabela; limpar devolve todas', async () => {
    mockUseVacancyFunnelTable.mockReturnValue({
      data: { ...mockData, rows: [frow('a', 'María López', true), frow('b', 'Juan Pérez', true)] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    expect(screen.getAllByTestId('mock-row')).toHaveLength(2);
    await userEvent.type(screen.getByTestId('funnel-filter-search'), 'maria');
    expect(screen.getAllByTestId('mock-row').map((n) => n.textContent)).toEqual(['a']);
    expect(screen.getByTestId('funnel-table')).toHaveAttribute('data-filtered', 'true');
    await userEvent.clear(screen.getByTestId('funnel-filter-search'));
    expect(screen.getAllByTestId('mock-row')).toHaveLength(2);
    expect(screen.getByTestId('funnel-table')).toHaveAttribute('data-filtered', 'false');
  });

  it('o seletor Registro filtra Completo/Incompleto', async () => {
    mockUseVacancyFunnelTable.mockReturnValue({
      data: { ...mockData, rows: [frow('a', 'María', true), frow('b', 'Juan', false)] },
      isLoading: false, error: null, refetch: vi.fn(),
    });
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(listBtn());
    await userEvent.selectOptions(screen.getByTestId('funnel-filter-registration'), 'INCOMPLETE');
    expect(screen.getAllByTestId('mock-row').map((n) => n.textContent)).toEqual(['b']);
    await userEvent.selectOptions(screen.getByTestId('funnel-filter-registration'), 'COMPLETE');
    expect(screen.getAllByTestId('mock-row').map((n) => n.textContent)).toEqual(['a']);
  });

  it('os filtros ficam só na Lista: o Kanban não tem busca nem seletor', () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    expect(screen.queryByTestId('funnel-filter-search')).toBeNull();
    expect(screen.queryByTestId('funnel-filter-registration')).toBeNull();
  });

  it('na visão Kanban, "Hacer match" e "Enviar invitaciones (N)" estão presentes, com o mesmo N da Lista (054 item 6)', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE',
        permissions: ['funnel:read', 'match:execute', 'messaging:send'],
        countries: [], groups: [], features: {}, enforcement: 'on',
      } as AuthzContract,
    });
    const { unmount } = render(<VacancyFunnelView vacancyId="vac-1" />);
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hacer match/ })).toBeInTheDocument();
    const kanbanInvite = screen.getByRole('button', {
      name: /dispatchInvitesButtonCount/,
    });
    expect(kanbanInvite).toHaveTextContent('dispatchInvitesButtonCount:3');
    expect(kanbanInvite).toBeEnabled();
    unmount();

    localStorage.setItem(NEW_KEY, 'list');
    render(<VacancyFunnelView vacancyId="vac-1" />);
    expect(screen.getByTestId('funnel-table')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /dispatchInvitesButtonCount/ }),
    ).toHaveTextContent('dispatchInvitesButtonCount:3');
  });
});
