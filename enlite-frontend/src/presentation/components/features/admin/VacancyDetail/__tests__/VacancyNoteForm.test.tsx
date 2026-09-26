import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

import { VacancyNoteForm } from '../VacancyNoteForm';

describe('VacancyNoteForm', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onSubmit.mockReset();
    onCancel.mockReset();
  });

  it('Guardar começa desabilitado (con quién e qué vazios)', () => {
    render(<VacancyNoteForm onSubmit={onSubmit} onCancel={onCancel} isSaving={false} />);
    expect(screen.getByTestId('vacancy-note-save')).toBeDisabled();
  });

  it('preenchendo "con quién" e "qué" habilita Guardar; onSubmit recebe ISO e textos aparados', async () => {
    render(<VacancyNoteForm onSubmit={onSubmit} onCancel={onCancel} isSaving={false} />);

    await userEvent.click(screen.getByTestId('vacancy-note-contact'));
    await userEvent.keyboard('  grupo Facebook X  ');
    await userEvent.click(screen.getByTestId('vacancy-note-body'));
    await userEvent.keyboard('  Publicado no grupo  ');

    expect(screen.getByTestId('vacancy-note-save')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('vacancy-note-save'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.contact).toBe('grupo Facebook X');
    expect(payload.body).toBe('Publicado no grupo');
    expect(payload.category).toBe('CONTATO');
    expect(() => new Date(payload.occurredAt).toISOString()).not.toThrow();
    expect(new Date(payload.occurredAt).toISOString()).toBe(payload.occurredAt);
  });

  it('clicar em Cancelar chama onCancel', async () => {
    render(<VacancyNoteForm onSubmit={onSubmit} onCancel={onCancel} isSaving={false} />);
    await userEvent.click(screen.getByTestId('vacancy-note-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('isSaving=true desabilita Guardar e Cancelar', () => {
    render(<VacancyNoteForm onSubmit={onSubmit} onCancel={onCancel} isSaving />);
    expect(screen.getByTestId('vacancy-note-save')).toBeDisabled();
    expect(screen.getByTestId('vacancy-note-cancel')).toBeDisabled();
  });
});
