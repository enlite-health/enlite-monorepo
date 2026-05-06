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
    render(
      <VacancyFunnelTable
        rows={mockRows}
        isLoading={false}
        activeBucket="INVITED"
      />,
    );
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
    render(
      <VacancyFunnelTable
        rows={mockRows}
        isLoading={false}
        activeBucket="INVITED"
      />,
    );
    // Name appears in both WorkerAvatar mock and the name span; use getAllByText
    expect(screen.getAllByText('Juan Pérez').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Maria García').length).toBeGreaterThan(0);
  });

  it('renders empty state when rows is empty', () => {
    render(
      <VacancyFunnelTable
        rows={[]}
        isLoading={false}
        activeBucket="INVITED"
      />,
    );
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.emptyState'),
    ).toBeInTheDocument();
  });

  it('renders spinner when loading and no rows', () => {
    const { container } = render(
      <VacancyFunnelTable
        rows={[]}
        isLoading={true}
        activeBucket="INVITED"
      />,
    );
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders table with role=table', () => {
    render(
      <VacancyFunnelTable
        rows={mockRows}
        isLoading={false}
        activeBucket="INVITED"
      />,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
