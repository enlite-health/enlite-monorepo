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

vi.mock('./VacancyFunnelKanban', () => ({
  VacancyFunnelKanban: ({ vacancyId }: { vacancyId: string }) => (
    <div data-testid="kanban-board">{vacancyId}</div>
  ),
}));

vi.mock('./VacancyFunnelTable', () => ({
  VacancyFunnelTable: () => <div data-testid="funnel-table" />,
}));

vi.mock('./VacancyFunnelTabs', () => ({
  VacancyFunnelTabs: ({
    onDispatchInvites,
    onBucketChange,
  }: {
    onDispatchInvites: () => void;
    onBucketChange: (b: string) => void;
  }) => (
    <div data-testid="funnel-tabs">
      <button onClick={() => onBucketChange('POSTULATED')}>postulated</button>
      <button onClick={onDispatchInvites}>dispatch</button>
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
  },
};

beforeEach(() => {
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
});
