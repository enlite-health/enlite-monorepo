/**
 * Testes do 1.5b (D344): motivo de lista fechada obrigatório, nota opcional com limite de
 * caracteres, aviso clínico sempre visível.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContestModal } from './ContestModal';
import { CONTEST_NOTE_MAX_LENGTH, CONTEST_REASONS } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key.startsWith('admin.anacareHours.contestModal.reasons.')) return key.split('.').pop() as string;
      return opts ? `${key}|${JSON.stringify(opts)}` : key;
    },
  }),
}));

describe('ContestModal — 1.5b (D344)', () => {
  it('POSITIVO — lista as 4 opções de motivo fechado (no_asistio, horario_distinto, horas_mal_cargadas, otro)', () => {
    render(<ContestModal shiftDate="14/08" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByTestId('anacare-hours-contest-reason') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(values).toEqual([...CONTEST_REASONS]);
  });

  it('NEGATIVO — confirmar fica desabilitado sem motivo escolhido', () => {
    render(<ContestModal shiftDate="14/08" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-contest-confirm')).toBeDisabled();
  });

  it('POSITIVO — escolher um motivo habilita confirmar mesmo com nota vazia (nota é opcional)', () => {
    const onConfirm = vi.fn();
    render(<ContestModal shiftDate="14/08" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'no_asistio' } });
    expect(screen.getByTestId('anacare-hours-contest-confirm')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('no_asistio', '');
  });

  it('POSITIVO — nota preenchida é enviada trimada junto do motivo', () => {
    const onConfirm = vi.fn();
    render(<ContestModal shiftDate="14/08" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'otro' } });
    fireEvent.change(screen.getByTestId('anacare-hours-contest-note'), { target: { value: '  nota com espaço  ' } });
    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('otro', 'nota com espaço');
  });

  it(`NEGATIVO — nota acima de ${CONTEST_NOTE_MAX_LENGTH} caracteres desabilita confirmar, mesmo com motivo escolhido`, () => {
    render(<ContestModal shiftDate="14/08" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'otro' } });
    // maxLength do <textarea> é CONTEST_NOTE_MAX_LENGTH+1, então dá pra digitar 1 a mais e disparar o estado overLimit.
    fireEvent.change(screen.getByTestId('anacare-hours-contest-note'), { target: { value: 'x'.repeat(CONTEST_NOTE_MAX_LENGTH + 1) } });
    expect(screen.getByTestId('anacare-hours-contest-confirm')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-contest-note-count')).toHaveClass('!text-red-600');
  });

  it('POSITIVO — aviso clínico fixo sempre visível', () => {
    render(<ContestModal shiftDate="14/08" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-contest-clinical-warning')).toHaveTextContent('admin.anacareHours.contestModal.clinicalWarning');
  });

  it('POSITIVO — cancelar chama onCancel', () => {
    const onCancel = vi.fn();
    render(<ContestModal shiftDate="14/08" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('anacare-hours-contest-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('NEGATIVO — clicar confirmar sem motivo (via DOM, ignorando o disabled) não chama onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ContestModal shiftDate="14/08" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
