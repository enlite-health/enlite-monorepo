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
    kanbanColumn: null,
    isBlocked: false,
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
    kanbanColumn: null,
    isBlocked: false,
  },
];

const defaultProps = {
  vacancyId: 'vac-1',
  rows: mockRows,
  isLoading: false,
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

  it('com filtro aplicado e nenhuma linha, mostra o vazio do FILTRO (não o da vaga)', () => {
    renderTable({ ...defaultProps, rows: [], isFiltered: true });
    expect(screen.getByTestId('funnel-empty-filtered')).toHaveTextContent(
      'admin.vacancyDetail.funnelTable.emptyFiltered',
    );
    expect(screen.queryByText('admin.vacancyDetail.funnelTable.emptyState')).toBeNull();
  });

  it('sem filtro e nenhuma linha, mostra o vazio da vaga (sem funnel-empty-filtered)', () => {
    renderTable({ ...defaultProps, rows: [], isFiltered: false });
    expect(screen.queryByTestId('funnel-empty-filtered')).toBeNull();
    expect(screen.getByText('admin.vacancyDetail.funnelTable.emptyState')).toBeInTheDocument();
  });

  it('renders spinner when loading and no rows', () => {
    const { container } = renderTable({ ...defaultProps, rows: [], isLoading: true });
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders table with role=table', () => {
    renderTable(defaultProps);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('renders the worker name as a link that opens the profile in a NEW TAB', () => {
    renderTable(defaultProps, '/admin/vacancies/vac-123');
    const links = screen.getAllByTestId('funnel-worker-link');
    expect(links[0]).toHaveAttribute('href', '/admin/workers/w-1');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(links[0]);
    // Nova aba: a lista da vaga não navega
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens the contact notes modal for the row when the notes button is clicked', () => {
    renderTable(defaultProps);
    fireEvent.click(screen.getAllByTestId('funnel-notes-button')[0]);
    expect(screen.getByText('admin.vacancyDetail.funnelTable.contactNotes.modalTitle')).toBeInTheDocument();
  });

  it('renders plain text (no link) when the row has no workerId', () => {
    const rowsNoId: FunnelTableRow[] = [{ ...mockRows[0], workerId: '' }, { ...mockRows[1], workerId: '' }];
    renderTable({ ...defaultProps, rows: rowsNoId });
    expect(screen.queryByTestId('funnel-worker-link')).not.toBeInTheDocument();
    expect(screen.getAllByText('Juan Pérez').length).toBeGreaterThan(0);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders "—" with no title on the link when the row has a workerId but no workerName', () => {
    const rows: FunnelTableRow[] = [{ ...mockRows[0], workerName: null }];
    renderTable({ ...defaultProps, rows });
    const link = screen.getByTestId('funnel-worker-link');
    expect(link).toHaveTextContent('—');
    expect(link).not.toHaveAttribute('title');
  });

  it('renders "—" with no title on the plain text when the row has neither workerId nor workerName', () => {
    const rows: FunnelTableRow[] = [
      { ...mockRows[0], workerId: '', workerName: null, kanbanColumn: 'INVITED' },
    ];
    renderTable({ ...defaultProps, rows });
    expect(screen.queryByTestId('funnel-worker-link')).not.toBeInTheDocument();
    const nameText = screen.getByText('—');
    expect(nameText).not.toHaveAttribute('title');
  });
});

// 054 item 2: saem as colunas Origen e ACEPTÓ da Lista (o selo de auto-postulação segue no card do Kanban).
describe('VacancyFunnelTable — sem as colunas Origen e ACEPTÓ (054 item 2)', () => {
  const props = { vacancyId: 'vac-123', isLoading: false };

  it('os headers não contêm origin nem accepted', () => {
    renderTable({ ...props, rows: mockRows });
    expect(screen.queryByText('admin.vacancyDetail.funnelTable.headers.origin')).toBeNull();
    expect(screen.queryByText('admin.vacancyDetail.funnelTable.headers.accepted')).toBeNull();
  });

  it('linha auto-postulada e com accepted=false não renderiza selo nem rótulo Sí/No', () => {
    const rows: FunnelTableRow[] = [
      { ...mockRows[0], selfAppliedAt: '2026-08-07T13:51:19.923Z', accepted: false },
    ];
    renderTable({ ...props, rows });
    expect(screen.queryByTestId('funnel-self-applied-badge')).toBeNull();
    expect(screen.queryByText('admin.vacancyDetail.funnelTable.acceptedNo')).toBeNull();
    expect(screen.queryByText('admin.vacancyDetail.funnelTable.acceptedYes')).toBeNull();
  });
});

// 054 item 3: a SEQUÊNCIA dos headers, não só a presença.
describe('VacancyFunnelTable — ordem das colunas (054 itens 3 e 4)', () => {
  it('headers renderizados: NOTAS, NOMBRE, REGISTRO, ETAPA, TELÉFONO, FECHA DE INVITACIÓN, WHATSAPP', () => {
    renderTable({ vacancyId: 'vac-1', isLoading: false, rows: mockRows });
    const seq = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(seq).toEqual([
      'admin.vacancyDetail.funnelTable.headers.notes',
      'admin.vacancyDetail.funnelTable.headers.name',
      'admin.vacancyDetail.funnelTable.headers.registration',
      'admin.vacancyDetail.funnelTable.headers.stage',
      'admin.vacancyDetail.funnelTable.headers.phone',
      'admin.vacancyDetail.funnelTable.headers.inviteDate',
      'admin.vacancyDetail.funnelTable.headers.whatsapp',
    ]);
  });
});

// Ordenação por km (DX-3.11): o modo lista usa o MESMO comparador do Kanban.
describe('VacancyFunnelTable — ordem por km (DX-3.11)', () => {
  const props = { vacancyId: 'vac-123', isLoading: false };

  it('ordena as linhas por km crescente, com sem-distância no fim', () => {
    const r40: FunnelTableRow = { ...mockRows[0], id: 'r40', distanceKm: 40 };
    const rNull: FunnelTableRow = { ...mockRows[0], id: 'rNull', distanceKm: null };
    const r3: FunnelTableRow = { ...mockRows[0], id: 'r3', distanceKm: 3 };
    const r12: FunnelTableRow = { ...mockRows[0], id: 'r12', distanceKm: 12 };

    renderTable({ ...props, rows: [r40, rNull, r3, r12] });

    const rows = screen.getAllByTestId(/^funnel-row-/);
    const ids = rows.map((el) => el.getAttribute('data-testid')!.replace('funnel-row-', ''));
    expect(ids).toEqual(['r3', 'r12', 'r40', 'rNull']);
  });
});
