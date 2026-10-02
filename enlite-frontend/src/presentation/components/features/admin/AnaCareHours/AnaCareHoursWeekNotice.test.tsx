import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnaCareHoursWeekNotice } from './AnaCareHoursWeekNotice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key), i18n: { language: 'es' } }),
}));

const ok = { state: 'ok' as const, error: null };

describe('AnaCareHoursWeekNotice', () => {
  it('todos ok e sem turnos → "sin turnos"', () => {
    render(<AnaCareHoursWeekNotice states={[{ month: '2026-09', status: ok }]} hasShifts={false} />);
    expect(screen.getByTestId('anacare-hours-week-empty')).toBeInTheDocument();
  });
  it('todos ok com turnos → nada', () => {
    const { container } = render(<AnaCareHoursWeekNotice states={[{ month: '2026-09', status: ok }]} hasShifts />);
    expect(container).toBeEmptyDOMElement();
  });
  it('mês em voo → carregando, nunca "sin turnos" (mesmo sem turnos ainda)', () => {
    render(<AnaCareHoursWeekNotice states={[{ month: '2026-09', status: ok }, { month: '2026-10', status: { state: 'loading', error: null } }]} hasShifts={false} />);
    expect(screen.getByTestId('anacare-hours-week-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-week-empty')).not.toBeInTheDocument();
  });
  it('mês com erro → erro com o nome do mês e "Reintentar"; nunca "sin turnos"', () => {
    const onRetryMonth = vi.fn();
    render(<AnaCareHoursWeekNotice states={[{ month: '2026-10', status: { state: 'error', error: 'caiu' } }]} hasShifts={false} onRetryMonth={onRetryMonth} />);
    expect(screen.getByTestId('anacare-hours-week-error')).toHaveTextContent('Octubre 2026');
    expect(screen.queryByTestId('anacare-hours-week-empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-week-retry-2026-10'));
    expect(onRetryMonth).toHaveBeenCalledWith('2026-10');
  });
  it('FONTE_NAO_CONFIGURADA mantém a mensagem que o detalhe já tinha', () => {
    render(<AnaCareHoursWeekNotice states={[{ month: '2026-10', status: { state: 'error', error: 'FONTE_NAO_CONFIGURADA' } }]} hasShifts={false} />);
    expect(screen.getByTestId('anacare-hours-week-error')).toHaveTextContent('admin.anacareHours.error.sourceNotConfigured');
  });
  it('sem onRetryMonth não há botão (nunca botão morto)', () => {
    render(<AnaCareHoursWeekNotice states={[{ month: '2026-10', status: { state: 'error', error: 'x' } }]} hasShifts={false} />);
    expect(screen.queryByTestId('anacare-hours-week-retry-2026-10')).not.toBeInTheDocument();
  });
});
