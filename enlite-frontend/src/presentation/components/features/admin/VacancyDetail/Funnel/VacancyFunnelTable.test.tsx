import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VacancyFunnelTable } from './VacancyFunnelTable';
import type { FunnelTableRow } from '@domain/entities/Funnel';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderTable(
  props: Parameters<typeof VacancyFunnelTable>[0],
  initialPath = '/admin/vacancies/vac-123',
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <VacancyFunnelTable {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockNavigate.mockReset();
});

vi.mock('@presentation/components/atoms/WorkerAvatar', () => ({
  WorkerAvatar: ({ name }: { name: string | null }) => (
    <div data-testid="worker-avatar">{name}</div>
  ),
}));

vi.mock('@presentation/components/atoms/WhatsappStatusBadge', () => ({
  WhatsappStatusBadge: ({ status }: { status: string | null }) => (
    <span data-testid="whatsapp-badge">{status}</span>
  ),
}));

const mockRows: FunnelTableRow[] = [
  {
    id: 'row-1',
    workerId: 'w-1',
    workerName: 'Juan Pérez',
    workerEmail: 'juan@example.com',
    workerPhone: '+54 9 11 1234-5678',
    workerAvatarUrl: null,
    invitedAt: '2026-01-15T00:00:00.000Z',
    funnelStage: 'INVITED',
    whatsappStatus: 'SENT',
    whatsappLastDispatchedAt: null,
    accepted: true,
    interviewResponse: null,
  },
  {
    id: 'row-2',
    workerId: 'w-2',
    workerName: 'Maria García',
    workerEmail: null,
    workerPhone: null,
    workerAvatarUrl: null,
    invitedAt: '2026-01-16T00:00:00.000Z',
    funnelStage: 'INVITED',
    whatsappStatus: null,
    whatsappLastDispatchedAt: null,
    accepted: null,
    interviewResponse: null,
  },
];

describe('VacancyFunnelTable', () => {
  it('renders table headers', () => {
    renderTable({ rows: mockRows, isLoading: false, activeBucket: 'INVITED' });
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.headers.name'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.headers.phone'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.headers.inviteDate'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.headers.whatsapp'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.headers.accepted'),
    ).toBeInTheDocument();
  });

  it('renders rows', () => {
    renderTable({ rows: mockRows, isLoading: false, activeBucket: 'INVITED' });
    // Name appears in both WorkerAvatar mock and the name span; use getAllByText
    expect(screen.getAllByText('Juan Pérez').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Maria García').length).toBeGreaterThan(0);
  });

  it('renders empty state when rows is empty', () => {
    renderTable({ rows: [], isLoading: false, activeBucket: 'INVITED' });
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.emptyState'),
    ).toBeInTheDocument();
  });

  it('renders spinner when loading and no rows', () => {
    const { container } = renderTable({ rows: [], isLoading: true, activeBucket: 'INVITED' });
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders table with role=table', () => {
    renderTable({ rows: mockRows, isLoading: false, activeBucket: 'INVITED' });
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('navigates to worker detail with origin path in state when clicking the name', () => {
    renderTable(
      { rows: mockRows, isLoading: false, activeBucket: 'INVITED' },
      '/admin/vacancies/vac-123',
    );
    const links = screen.getAllByTestId('funnel-worker-link');
    fireEvent.click(links[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers/w-1', {
      state: { from: '/admin/vacancies/vac-123' },
    });
  });

  it('does not navigate when the row has no workerId', () => {
    const rowsNoId: FunnelTableRow[] = [{ ...mockRows[0], workerId: '' }];
    renderTable({ rows: rowsNoId, isLoading: false, activeBucket: 'INVITED' });
    const link = screen.getByTestId('funnel-worker-link');
    expect(link).toBeDisabled();
    fireEvent.click(link);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
