import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  // O input `datetime-local` é interpretado como hora de -03 (Buenos Aires), não do navegador.
  // Rodar com TZ=Asia/Tokyo e TZ=America/Los_Angeles: no fuso do host o ISO sairia outro.
  it('"Cuándo" digitado 19:00 vira 22:00Z (hora de -03), qualquer que seja o fuso do navegador', async () => {
    render(<VacancyNoteForm onSubmit={onSubmit} onCancel={onCancel} isSaving={false} />);

    fireEvent.change(screen.getByTestId('vacancy-note-when'), { target: { value: '2026-10-07T19:00' } });
    await userEvent.click(screen.getByTestId('vacancy-note-contact'));
    await userEvent.keyboard('grupo');
    await userEvent.click(screen.getByTestId('vacancy-note-body'));
    await userEvent.keyboard('texto');
    await userEvent.click(screen.getByTestId('vacancy-note-save'));

    expect(onSubmit.mock.calls[0][0].occurredAt).toBe('2026-10-07T22:00:00.000Z');
  });

  it('o "Cuándo" inicial mostra a hora de -03 de agora, não a do navegador', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T02:30:00Z'));
    try {
      render(<VacancyNoteForm onSubmit={onSubmit} onCancel={onCancel} isSaving={false} />);
      expect((screen.getByTestId('vacancy-note-when') as HTMLInputElement).value).toBe('2026-10-07T23:30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Cuándo" vazio desabilita Guardar e não chama onSubmit', async () => {
    render(<VacancyNoteForm onSubmit={onSubmit} onCancel={onCancel} isSaving={false} />);

    await userEvent.clear(screen.getByTestId('vacancy-note-when'));
    await userEvent.click(screen.getByTestId('vacancy-note-contact'));
    await userEvent.keyboard('  grupo Facebook X  ');
    await userEvent.click(screen.getByTestId('vacancy-note-body'));
    await userEvent.keyboard('  Publicado no grupo  ');

    expect(screen.getByTestId('vacancy-note-save')).toBeDisabled();
    await userEvent.click(screen.getByTestId('vacancy-note-save'));

    expect(onSubmit).not.toHaveBeenCalled();
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
