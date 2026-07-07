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

// ContactNotesModal como leaf — prova que a tabela abre o modal escopado à
// VAGA (vacancyId), não por row/workerId.
vi.mock('./ContactNotesModal', () => ({
  ContactNotesModal: ({ vacancyId, onClose }: { vacancyId: string; onClose: () => void }) => (
    <div data-testid="contact-notes-modal" data-vacancy-id={vacancyId}>
      <button type="button" onClick={onClose}>close</button>
    </div>
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
    renderTable(defaultProps);
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
    renderTable(defaultProps);
    // Name appears in both WorkerAvatar mock and the name span; use getAllByText
    expect(screen.getAllByText('Juan Pérez').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Maria García').length).toBeGreaterThan(0);
  });

  it('renders registration complete badge', () => {
    renderTable(defaultProps);
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
    renderTable(defaultProps);
    // row-1 has contactNotesCount=2
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders empty state when rows is empty', () => {
    renderTable({ ...defaultProps, rows: [] });
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.emptyState'),
    ).toBeInTheDocument();
  });

  it('renders spinner when loading and no rows', () => {
    const { container } = renderTable({ ...defaultProps, rows: [], isLoading: true });
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders table with role=table', () => {
    renderTable(defaultProps);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('navigates to worker detail with origin path in state when clicking the name', () => {
    renderTable(defaultProps, '/admin/vacancies/vac-123');
    const links = screen.getAllByTestId('funnel-worker-link');
    fireEvent.click(links[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers/w-1', {
      state: { from: '/admin/vacancies/vac-123' },
    });
  });

  it('does not navigate when the row has no workerId', () => {
    const rowsNoId: FunnelTableRow[] = [{ ...mockRows[0], workerId: '' }];
    renderTable({ ...defaultProps, rows: rowsNoId });
    const link = screen.getByTestId('funnel-worker-link');
    expect(link).toBeDisabled();
    fireEvent.click(link);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('VacancyFunnelTable — comentários escopados à vaga (thread única)', () => {
  it('não renderiza o modal até um botão de comentários ser clicado', () => {
    renderTable(defaultProps);
    expect(screen.queryByTestId('contact-notes-modal')).not.toBeInTheDocument();
  });

  it('abre o mesmo modal (keyado por vacancyId, não por workerId) ao clicar em qualquer linha', () => {
    renderTable(defaultProps);
    const notesButtons = screen.getAllByTestId('funnel-notes-button');
    expect(notesButtons.length).toBe(mockRows.length);

    fireEvent.click(notesButtons[1]);
    const modal = screen.getByTestId('contact-notes-modal');
    expect(modal).toHaveAttribute('data-vacancy-id', defaultProps.vacancyId);
  });

  it('mantém o modal keyado pelo vacancyId mesmo clicando na primeira linha', () => {
    renderTable(defaultProps);
    fireEvent.click(screen.getAllByTestId('funnel-notes-button')[0]);
    const modal = screen.getByTestId('contact-notes-modal');
    expect(modal).toHaveAttribute('data-vacancy-id', defaultProps.vacancyId);
  });
});
