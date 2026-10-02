import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFunnelView } from './VacancyFunnelView';
import type { FunnelTableData } from '@domain/entities/Funnel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockUseVacancyFunnelTable = vi.fn();
vi.mock('@hooks/admin/useVacancyFunnelTable', () => ({
  useVacancyFunnelTable: (...args: unknown[]) =>
    mockUseVacancyFunnelTable(...args),
}));

vi.mock('@hooks/admin/useInvitedPendingCandidates', () => ({
  useInvitedPendingCandidates: () => ({
    candidates: [],
    pendingCount: 0,
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
  VacancyFunnelTable: () => <div data-testid="funnel-table" />,
}));

// A View só lê `tab.key` do que a aba devolve (handleTabChange); quem resolve o FunnelTab
// completo (kind/column/bucket) é a própria View, buscando em FUNNEL_TABS de verdade por essa
// key — por isso o mock abaixo só precisa devolver a key, sem duplicar o shape de FunnelTab.
vi.mock('./VacancyFunnelTabs', () => ({
  VacancyFunnelTabs: ({
    onTabChange,
  }: {
    onTabChange: (tab: { key: string }) => void;
  }) => (
    <div data-testid="funnel-tabs">
      <button onClick={() => onTabChange({ key: 'POSTULATED' })}>postulated</button>
      <button onClick={() => onTabChange({ key: 'PRE_SCREENING' })}>pre-screening</button>
    </div>
  ),
}));

vi.mock('./VacancyFunnelToggle', () => ({
  VacancyFunnelToggle: ({
    onChange,
    view,
  }: {
    onChange: (v: string) => void;
    view: string;
  }) => (
    <div data-testid="funnel-toggle">
      <button onClick={() => onChange('list')}>list-btn</button>
      <button onClick={() => onChange('kanban')}>kanban-btn</button>
      <span>{view}</span>
    </div>
  ),
}));

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

describe('VacancyFunnelView', () => {
  it('renders toggle, tabs and table in list view by default', () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    expect(screen.getByTestId('funnel-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('funnel-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('funnel-table')).toBeInTheDocument();
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
  });

  it('switches to kanban when kanban button is clicked', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(screen.getByText('kanban-btn'));
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    expect(screen.queryByTestId('funnel-tabs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('funnel-table')).not.toBeInTheDocument();
  });

  it('switches back to list from kanban', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(screen.getByText('kanban-btn'));
    await userEvent.click(screen.getByText('list-btn'));
    expect(screen.getByTestId('funnel-table')).toBeInTheDocument();
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
  });

  it('passes vacancyId to KanbanBoard when in kanban view', async () => {
    render(<VacancyFunnelView vacancyId="vac-42" />);
    await userEvent.click(screen.getByText('kanban-btn'));
    expect(screen.getByTestId('kanban-board')).toHaveTextContent('vac-42');
  });

  it('does not call useVacancyFunnelTable with enabled=true in kanban view', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(screen.getByText('kanban-btn'));
    // The hook should have been called with enabled=false in kanban mode
    const lastCall =
      mockUseVacancyFunnelTable.mock.calls[
        mockUseVacancyFunnelTable.mock.calls.length - 1
      ];
    expect(lastCall[2]).toBe(false);
  });

  it('clicar em "Pre Screening" chama o hook com a coluna (sources PRE_SCREENING + IN_PROGRESS)', async () => {
    render(<VacancyFunnelView vacancyId="vac-1" />);
    await userEvent.click(screen.getByText('pre-screening'));
    const lastCall =
      mockUseVacancyFunnelTable.mock.calls[
        mockUseVacancyFunnelTable.mock.calls.length - 1
      ];
    const tabArg = lastCall[1] as { kind: string; column: { sources: string[] } };
    expect(tabArg.kind).toBe('column');
    expect(tabArg.column.sources).toEqual(['PRE_SCREENING', 'IN_PROGRESS']);
  });
});
