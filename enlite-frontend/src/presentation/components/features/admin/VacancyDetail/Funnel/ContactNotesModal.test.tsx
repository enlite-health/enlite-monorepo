import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ContactNotesModal } from './ContactNotesModal';
import type { ContactNote } from '@domain/entities/ContactNote';

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
  it('renders the vacancy-scoped title (not a worker name)', () => {
    render(<ContactNotesModal {...defaultProps} />);
    expect(
      screen.getByText(
        'admin.vacancyDetail.funnelTable.contactNotes.modalTitleVacancy',
      ),
    ).toBeInTheDocument();
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
});
