import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacancyBajaConfirmDialog } from '../VacancyBajaConfirmDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k) }),
}));

describe('VacancyBajaConfirmDialog (spec 084 P5)', () => {
  it('lote: mostra QUANTAS vagas e QUAIS casos; confirmar e cancelar chamam os callbacks', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<VacancyBajaConfirmDialog variant="list" count={3} cases={[230, 817]} isWorking={false} error={null} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByTestId('vacancy-baja-confirm-title')).toHaveTextContent('"count":3');
    expect(screen.getByTestId('vacancy-baja-confirm-cases')).toHaveTextContent('230, 817');
    fireEvent.click(screen.getByTestId('vacancy-baja-confirm-ok'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('vacancy-baja-confirm-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ficha: sem lista de casos; trabalhando desabilita os botões; erro aparece como alerta', () => {
    render(<VacancyBajaConfirmDialog variant="detail" count={1} isWorking error="falhou" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('vacancy-baja-confirm-cases')).not.toBeInTheDocument();
    expect(screen.getByTestId('vacancy-baja-confirm-ok')).toBeDisabled();
    expect(screen.getByTestId('vacancy-baja-confirm-cancel')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('falhou');
  });
});
