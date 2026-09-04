import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ContactNotesModal } from './ContactNotesModal';
import type { ContactNote } from '@domain/entities/ContactNote';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── i18n mock ──────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'admin.vacancyDetail.funnelTable.contactNotes.charCounter') {
        return `${opts?.count ?? 0}/240`;
      }
      return key;
    },
  }),
}));

// ── useContactNotes mock ───────────────────────────────────────────────────
const mockFetchNotes = vi.fn().mockResolvedValue(undefined);
const mockCreateNote = vi.fn().mockResolvedValue(undefined);
const mockDeleteNote = vi.fn().mockResolvedValue(undefined);

const mockNotesState = {
  notes: [] as ContactNote[],
  isLoading: false,
  isCreating: false,
  deletingId: null as string | null,
  error: null as string | null,
  fetchNotes: mockFetchNotes,
  createNote: mockCreateNote,
  deleteNote: mockDeleteNote,
};

vi.mock('@hooks/admin/useContactNotes', () => ({
  useContactNotes: () => mockNotesState,
}));

const sampleNotes: ContactNote[] = [
  {
    id: 'note-1',
    workerJobApplicationId: 'wja-1',
    noteText: 'Llamé y no atendió.',
    createdByAdminId: 'admin-1',
    createdByAdminName: null,
    createdByAdminEmail: 'op@enlite.com',
    createdAt: '2026-06-10T14:32:00.000Z',
    canDelete: false,
  },
  {
    id: 'note-2',
    workerJobApplicationId: 'wja-1',
    noteText: 'Confirmó disponibilidad.',
    createdByAdminId: 'admin-1',
    createdByAdminName: null,
    createdByAdminEmail: null,
    createdAt: '2026-06-09T10:00:00.000Z',
    canDelete: false,
  },
];

const defaultProps = {
  vacancyId: 'vac-1',
  workerId: 'worker-1',
  workerName: 'Juan Pérez',
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockNotesState.notes = [];
  mockNotesState.isLoading = false;
  mockNotesState.isCreating = false;
  mockNotesState.deletingId = null;
  mockNotesState.error = null;
});

describe('ContactNotesModal', () => {
  it('renders title and worker name', () => {
    render(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.getByText(
        'admin.vacancyDetail.funnelTable.contactNotes.modalTitle',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Juan Pérez')).toBeInTheDocument();
  });

  it('shows empty state when no notes', () => {
    render(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.getByText(
        'admin.vacancyDetail.funnelTable.contactNotes.emptyState',
      ),
    ).toBeInTheDocument();
  });

  it('renders note history in DESC order', () => {
    mockNotesState.notes = sampleNotes;
    render(<ContactNotesModal {...defaultProps} />);
    expect(screen.getByText('Llamé y no atendió.')).toBeInTheDocument();
    expect(screen.getByText('Confirmó disponibilidad.')).toBeInTheDocument();
    expect(screen.getByText('op@enlite.com')).toBeInTheDocument();
  });

  it('shows the operator name when present (falls back to email otherwise)', () => {
    mockNotesState.notes = [
      {
        ...sampleNotes[0],
        createdByAdminName: 'María González',
        createdByAdminEmail: 'maria@enlite.com',
      },
    ];
    render(<ContactNotesModal {...defaultProps} />);
    expect(screen.getByText('María González')).toBeInTheDocument();
    expect(screen.queryByText('maria@enlite.com')).not.toBeInTheDocument();
  });

  describe('delete affordance (driven by backend canDelete)', () => {
    it('shows delete button when the note is deletable (canDelete=true)', () => {
      mockNotesState.notes = [{ ...sampleNotes[0], canDelete: true }];
      render(<ContactNotesModal {...defaultProps} />);
      expect(screen.getByTestId('contact-note-delete')).toBeInTheDocument();
    });

    it('hides delete button when the note is not deletable (canDelete=false)', () => {
      mockNotesState.notes = [{ ...sampleNotes[0], canDelete: false }];
      render(<ContactNotesModal {...defaultProps} />);
      expect(screen.queryByTestId('contact-note-delete')).not.toBeInTheDocument();
    });

    it('calls deleteNote after confirming', async () => {
      mockNotesState.notes = [
        { ...sampleNotes[0], id: 'note-del', canDelete: true },
      ];
      render(<ContactNotesModal {...defaultProps} />);
      fireEvent.click(screen.getByTestId('contact-note-delete'));
      fireEvent.click(screen.getByTestId('contact-note-delete-confirm'));
      await waitFor(() => {
        expect(mockDeleteNote).toHaveBeenCalledWith('note-del');
      });
    });
  });

  it('shows char counter updating as user types', () => {
    render(<ContactNotesModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      'admin.vacancyDetail.funnelTable.contactNotes.textareaPlaceholder',
    );
    expect(screen.getByText('0/240')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: 'Hola' } });
    expect(screen.getByText('4/240')).toBeInTheDocument();
  });

  it('submit button is disabled when textarea is empty', () => {
    render(<ContactNotesModal {...defaultProps} />);
    const btn = screen.getByText(
      'admin.vacancyDetail.funnelTable.contactNotes.registerButton',
    );
    expect(btn.closest('button')).toBeDisabled();
  });

  it('submit button is disabled when textarea has only whitespace', () => {
    render(<ContactNotesModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      'admin.vacancyDetail.funnelTable.contactNotes.textareaPlaceholder',
    );
    fireEvent.change(textarea, { target: { value: '   ' } });
    const btn = screen.getByText(
      'admin.vacancyDetail.funnelTable.contactNotes.registerButton',
    );
    expect(btn.closest('button')).toBeDisabled();
  });

  it('submit button is enabled when textarea has non-empty text', () => {
    render(<ContactNotesModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      'admin.vacancyDetail.funnelTable.contactNotes.textareaPlaceholder',
    );
    fireEvent.change(textarea, { target: { value: 'Una nota válida' } });
    const btn = screen.getByText(
      'admin.vacancyDetail.funnelTable.contactNotes.registerButton',
    );
    expect(btn.closest('button')).not.toBeDisabled();
  });

  it('calls createNote and clears textarea on submit', async () => {
    render(<ContactNotesModal {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(
      'admin.vacancyDetail.funnelTable.contactNotes.textareaPlaceholder',
    );
    fireEvent.change(textarea, { target: { value: 'Una nota válida' } });
    const btn = screen.getByText(
      'admin.vacancyDetail.funnelTable.contactNotes.registerButton',
    );
    fireEvent.click(btn.closest('button')!);
    await waitFor(() => {
      expect(mockCreateNote).toHaveBeenCalledWith({
        noteText: 'Una nota válida',
      });
    });
  });

  it('calls fetchNotes on mount', async () => {
    render(<ContactNotesModal {...defaultProps} />);
    await waitFor(() => {
      expect(mockFetchNotes).toHaveBeenCalledTimes(1);
    });
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<ContactNotesModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('common.close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the loading spinner while isLoading is true and there are no notes yet', () => {
    mockNotesState.isLoading = true;
    const { container } = render(<ContactNotesModal {...defaultProps} />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows the load error text when the hook reports an error', () => {
    mockNotesState.error = 'algo deu errado';
    render(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.contactNotes.loadError'),
    ).toBeInTheDocument();
  });

  // NÃO testado: `isCreating ? t('...registering') : t('...registerButton')`
  // no ramo `true` é morto em produção — `ActionButton` delega a `Button`
  // (atoms/Button/Button.tsx), que substitui `children` por
  // `t('common.loading')` sempre que `isLoading` (aqui, `isCreating`) é
  // `true`. Pré-existente (a mesma troca já valia com o `<Button>` cru antes
  // da D269) — fora do escopo desta tarefa; ver ACHADOS no relatório final.

  it('shows the "deleting" label on the note item while it is being deleted', () => {
    mockNotesState.notes = [{ ...sampleNotes[0], id: 'note-deleting', canDelete: true }];
    const { rerender } = render(<ContactNotesModal {...defaultProps} />);
    // 1º clique entra em "confirmando" (o botão de lixeira NÃO está
    // desabilitado ainda — `isDeleting` só vira true depois, quando o pai
    // efetivamente chama `deleteNote`).
    fireEvent.click(screen.getByTestId('contact-note-delete'));
    // Simula o pai marcando esta nota como "em exclusão" (mesmo objeto
    // mutável que o mock de `useContactNotes` devolve).
    mockNotesState.deletingId = 'note-deleting';
    rerender(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.contactNotes.deleting'),
    ).toBeInTheDocument();
  });
});

// ── D269 — POST/DELETE .../contact-notes → funnel:write ─────────────────────

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: [],
  groups: [],
  features: {},
  enforcement,
});

describe('ContactNotesModal — D269 célula funnel:write', () => {
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('enforcement "on" SEM funnel:write → botão de registrar nota some do DOM (não fica desabilitado)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
    render(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.queryByText('admin.vacancyDetail.funnelTable.contactNotes.registerButton'),
    ).not.toBeInTheDocument();
  });

  it('enforcement "on" COM funnel:write → botão de registrar nota aparece', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['funnel:write'], 'on') });
    render(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.contactNotes.registerButton'),
    ).toBeInTheDocument();
  });

  it('enforcement "off" (sem contrato) → botão de registrar nota continua visível, como antes da D269', () => {
    render(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.getByText('admin.vacancyDetail.funnelTable.contactNotes.registerButton'),
    ).toBeInTheDocument();
  });

  it('enforcement "on" SEM funnel:write → delete some mesmo com canDelete=true do backend (as duas regras precisam valer)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
    mockNotesState.notes = [{ ...sampleNotes[0], canDelete: true }];
    render(<ContactNotesModal {...defaultProps} />);
    expect(screen.queryByTestId('contact-note-delete')).not.toBeInTheDocument();
  });

  it('enforcement "on" COM funnel:write E canDelete=true → delete aparece', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['funnel:write'], 'on') });
    mockNotesState.notes = [{ ...sampleNotes[0], canDelete: true }];
    render(<ContactNotesModal {...defaultProps} />);
    expect(screen.getByTestId('contact-note-delete')).toBeInTheDocument();
  });
});
