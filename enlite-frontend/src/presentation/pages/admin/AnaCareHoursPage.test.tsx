import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate, mockSetSearchParams, searchParamsRef } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSetSearchParams: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [searchParamsRef.current, mockSetSearchParams],
}));

vi.mock('@presentation/components/features/admin/AnaCareHours/AnaCareHoursListContainer', () => ({
  AnaCareHoursListContainer: ({
    onOpenPatient,
    onMonthChange,
    initialMonth,
  }: {
    onOpenPatient: (id: string) => void;
    onMonthChange: (m: string) => void;
    initialMonth: string;
  }) => (
    <div data-testid="stub-list-container" data-initial-month={initialMonth}>
      <button data-testid="stub-open" onClick={() => onOpenPatient('90000')} />
      <button data-testid="stub-month" onClick={() => onMonthChange('2026-08')} />
    </div>
  ),
}));

import AnaCareHoursPage from './AnaCareHoursPage';

describe('AnaCareHoursPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00-03:00'));
    mockNavigate.mockClear();
    mockSetSearchParams.mockClear();
    searchParamsRef.current = new URLSearchParams();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSITIVO — sem ?month a lista abre no mês corrente e abrir o paciente leva ?month=<corrente>', () => {
    render(<AnaCareHoursPage />);
    expect(screen.getByTestId('stub-list-container')).toHaveAttribute('data-initial-month', '2026-10');
    fireEvent.click(screen.getByTestId('stub-open'));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/anacare/horas/90000?month=2026-10');
  });

  it('POSITIVO — ?month=2026-09 abre a lista em setembro e o paciente é aberto com o mesmo mês', () => {
    searchParamsRef.current = new URLSearchParams('month=2026-09');
    render(<AnaCareHoursPage />);
    expect(screen.getByTestId('stub-list-container')).toHaveAttribute('data-initial-month', '2026-09');
    fireEvent.click(screen.getByTestId('stub-open'));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/anacare/horas/90000?month=2026-09');
  });

  it('NEGATIVO — ?month inválido (abc, 2026-07) cai no mês corrente, sem erro', () => {
    for (const raw of ['abc', '2026-07']) {
      searchParamsRef.current = new URLSearchParams(`month=${raw}`);
      const { unmount } = render(<AnaCareHoursPage />);
      expect(screen.getByTestId('stub-list-container')).toHaveAttribute('data-initial-month', '2026-10');
      unmount();
    }
  });

  it('POSITIVO — trocar o seletor grava ?month SUBSTITUINDO a entrada do histórico (replace: true)', () => {
    render(<AnaCareHoursPage />);
    fireEvent.click(screen.getByTestId('stub-month'));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ month: '2026-08' }, { replace: true });
  });
});
