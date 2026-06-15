import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyFunnelTable } from './VacancyFunnelTable';
import type { FunnelTableRow } from '@domain/entities/Funnel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

vi.mock('@hooks/admin/useContactNotes', () => ({
  useContactNotes: () => ({
    notes: [],
    isLoading: false,
    isCreating: false,
    error: null,
    fetchNotes: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue(undefined),
  }),
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
    registrationComplete: true,
    contactNotesCount: 2,
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
    registrationComplete: false,
    contactNotesCount: 0,
  },
];

const defaultProps = {
  vacancyId: 'vac-1',
  rows: mockRows,
  isLoading: false,
  activeBucket: 'INVITED' as const,
};

describe('VacancyFunnelTable', () => {
  it('renders table headers including new ones', () => {
    render(<VacancyFunnelTable {...defaultProps} />);
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
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.headers.registration'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.headers.notes'),
    ).toBeInTheDocument();
  });

  it('renders rows', () => {
    render(<VacancyFunnelTable {...defaultProps} />);
    expect(screen.getAllByText('Juan Pérez').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Maria García').length).toBeGreaterThan(0);
  });

  it('renders registration complete badge', () => {
    render(<VacancyFunnelTable {...defaultProps} />);
    expect(
      screen.getByText(
        'admin.vacancyDetail.funnelTable.registration.complete',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'admin.vacancyDetail.funnelTable.registration.incomplete',
      ),
    ).toBeInTheDocument();
  });

  it('renders contactNotesCount for row with notes', () => {
    render(<VacancyFunnelTable {...defaultProps} />);
    // row-1 has contactNotesCount=2
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders empty state when rows is empty', () => {
    render(
      <VacancyFunnelTable {...defaultProps} rows={[]} />,
    );
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.emptyState'),
    ).toBeInTheDocument();
  });

  it('renders spinner when loading and no rows', () => {
    const { container } = render(
      <VacancyFunnelTable {...defaultProps} rows={[]} isLoading={true} />,
    );
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders table with role=table', () => {
    render(<VacancyFunnelTable {...defaultProps} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
