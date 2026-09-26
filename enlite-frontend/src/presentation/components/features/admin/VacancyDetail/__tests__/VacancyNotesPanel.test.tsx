import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'es' } }),
}));

const gateState = vi.hoisted(() => ({ allowed: true }));
vi.mock('@presentation/hooks/useCellAccess', () => ({
  useActionGate: () => ({ allowed: gateState.allowed, denied: !gateState.allowed }),
}));

const mockFetchNotes = vi.fn();
const mockCreateNote = vi.fn();
const hookState = vi.hoisted(() => ({
  notes: [] as any[],
  isLoading: false,
  isCreating: false,
  error: null as string | null,
}));
vi.mock('@hooks/admin/useVacancyNotes', () => ({
  useVacancyNotes: () => ({
    ...hookState,
    fetchNotes: mockFetchNotes,
    createNote: mockCreateNote,
  }),
}));

import { VacancyNotesPanel } from '../VacancyNotesPanel';

const sampleNote = {
  id: 'note-1',
  jobPostingId: 'vacancy-1',
  occurredAt: '2026-09-20T10:00:00.000Z',
  category: 'DIVULGACAO' as const,
  contact: 'grupo Facebook X',
  body: 'Publicado no grupo',
  createdBy: 'staff:abc',
  authorEmail: 'staff@enlite.health',
  createdAt: '2026-09-20T10:00:01.000Z',
};

describe('VacancyNotesPanel', () => {
  beforeEach(() => {
    gateState.allowed = true;
    hookState.notes = [];
    hookState.isLoading = false;
    hookState.isCreating = false;
    hookState.error = null;
    mockFetchNotes.mockReset().mockResolvedValue(undefined);
    mockCreateNote.mockReset().mockResolvedValue(undefined);
  });

  it('busca as notas ao montar', () => {
    render(<VacancyNotesPanel vacancyId="vacancy-1" />);
    expect(mockFetchNotes).toHaveBeenCalledTimes(1);
  });

  it('sem célula vacancy:update, o botão "Nueva anotación" não aparece', () => {
    gateState.allowed = false;
    render(<VacancyNotesPanel vacancyId="vacancy-1" />);
    expect(screen.queryByTestId('vacancy-notes-new-button')).not.toBeInTheDocument();
  });

  it('com célula, o botão aparece', () => {
    render(<VacancyNotesPanel vacancyId="vacancy-1" />);
    expect(screen.getByTestId('vacancy-notes-new-button')).toBeInTheDocument();
  });

  it('lista vazia mostra o texto de vazio', () => {
    render(<VacancyNotesPanel vacancyId="vacancy-1" />);
    expect(screen.getByText('admin.vacancyDetail.notes.empty')).toBeInTheDocument();
  });

  it('lista com notas renderiza uma linha por nota, na ordem recebida', () => {
    hookState.notes = [sampleNote, { ...sampleNote, id: 'note-2', authorEmail: null }];
    render(<VacancyNotesPanel vacancyId="vacancy-1" />);
    expect(screen.getByTestId('vacancy-note-row-note-1')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-note-row-note-2')).toBeInTheDocument();
    // autor = authorEmail ?? createdBy
    expect(screen.getByText('staff@enlite.health')).toBeInTheDocument();
    expect(screen.getByText('staff:abc')).toBeInTheDocument();
  });

  it('clicar em "Nueva anotación" abre o formulário', async () => {
    render(<VacancyNotesPanel vacancyId="vacancy-1" />);
    await userEvent.click(screen.getByTestId('vacancy-notes-new-button'));
    expect(screen.getByTestId('vacancy-note-save')).toBeInTheDocument();
  });

  it('erro no createNote mostra saveError e mantém o formulário aberto', async () => {
    mockCreateNote.mockRejectedValueOnce(new Error('Bad Request'));
    render(<VacancyNotesPanel vacancyId="vacancy-1" />);
    await userEvent.click(screen.getByTestId('vacancy-notes-new-button'));
    await userEvent.click(screen.getByTestId('vacancy-note-contact'));
    await userEvent.keyboard('grupo X');
    await userEvent.click(screen.getByTestId('vacancy-note-body'));
    await userEvent.keyboard('publicado');
    await userEvent.click(screen.getByTestId('vacancy-note-save'));
    await waitFor(() => expect(screen.getByText('admin.vacancyDetail.notes.saveError')).toBeInTheDocument());
    expect(screen.getByTestId('vacancy-note-save')).toBeInTheDocument();
  });
});
