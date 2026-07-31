import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InterviewScheduleSelect } from '../InterviewScheduleSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

/**
 * Captura da data da entrevista (change captura-data-entrevista).
 * Antes disso o sistema registrava QUE a entrevista foi agendada e nunca QUANDO — e por
 * isso lembrete de véspera, lembrete de 5min e no-show automático nunca dispararam.
 */
describe('InterviewScheduleSelect', () => {
  function preencher(date: string, time: string): void {
    fireEvent.change(screen.getByTestId('interview-date-input'), { target: { value: date } });
    fireEvent.change(screen.getByTestId('interview-time-input'), { target: { value: time } });
  }

  it('confirma com data e hora', () => {
    const onSubmit = vi.fn();
    render(<InterviewScheduleSelect onSubmit={onSubmit} onCancel={vi.fn()} />);

    preencher('2026-08-05', '14:30');
    fireEvent.click(screen.getByTestId('interview-schedule-confirm'));

    expect(onSubmit).toHaveBeenCalledWith({
      interviewDate: '2026-08-05',
      interviewTime: '14:30',
      interviewMeetLink: undefined,
    });
  });

  it('inclui o link da videochamada quando informado', () => {
    const onSubmit = vi.fn();
    render(<InterviewScheduleSelect onSubmit={onSubmit} onCancel={vi.fn()} />);

    preencher('2026-08-05', '09:00');
    fireEvent.change(screen.getByTestId('interview-meet-input'), {
      target: { value: 'https://meet.google.com/abc-defg-hij' },
    });
    fireEvent.click(screen.getByTestId('interview-schedule-confirm'));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ interviewMeetLink: 'https://meet.google.com/abc-defg-hij' }),
    );
  });

  it('normaliza link colado sem https:// (o backend valida URL e devolveria 400 com o modal já fechado)', () => {
    const onSubmit = vi.fn();
    render(<InterviewScheduleSelect onSubmit={onSubmit} onCancel={vi.fn()} />);

    preencher('2026-08-05', '09:00');
    fireEvent.change(screen.getByTestId('interview-meet-input'), {
      target: { value: 'meet.google.com/abc-defg-hij' },
    });
    fireEvent.click(screen.getByTestId('interview-schedule-confirm'));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ interviewMeetLink: 'https://meet.google.com/abc-defg-hij' }),
    );
  });

  it('não deixa confirmar com metade do agendamento', () => {
    render(<InterviewScheduleSelect onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId('interview-schedule-confirm')).toBeDisabled();

    fireEvent.change(screen.getByTestId('interview-date-input'), {
      target: { value: '2026-08-05' },
    });
    expect(screen.getByTestId('interview-schedule-confirm')).toBeDisabled();

    fireEvent.change(screen.getByTestId('interview-time-input'), { target: { value: '10:00' } });
    expect(screen.getByTestId('interview-schedule-confirm')).toBeEnabled();
  });

  it('"ainda não sei" move o card sem inventar horário', () => {
    const onSubmit = vi.fn();
    render(<InterviewScheduleSelect onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByTestId('interview-schedule-unknown'));

    // null = mover sem data. Não pode virar data de hoje nem string vazia.
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it('cancelar não agenda nada', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<InterviewScheduleSelect onSubmit={onSubmit} onCancel={onCancel} />);

    preencher('2026-08-05', '14:30');
    fireEvent.click(screen.getByTestId('interview-schedule-cancel'));

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
