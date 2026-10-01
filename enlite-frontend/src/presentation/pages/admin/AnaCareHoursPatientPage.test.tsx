import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate, mockUseParams, mockSetSearchParams, searchParamsRef } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseParams: vi.fn(),
  mockSetSearchParams: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockUseParams(),
  useSearchParams: () => [searchParamsRef.current, mockSetSearchParams],
}));

vi.mock('@presentation/components/features/admin/AnaCareHours/AnaCareHoursDetailContainer', () => ({
  AnaCareHoursDetailContainer: ({
    onBack,
    onMonthChange,
    patientId,
    month,
  }: {
    onBack: () => void;
    onMonthChange: (m: string) => void;
    patientId: string;
    month: string;
  }) => (
    <div data-testid="stub-detail-container" data-patient-id={patientId} data-month={month}>
      <button data-testid="stub-back" onClick={onBack} />
      <button data-testid="stub-month" onClick={() => onMonthChange('2026-09')} />
    </div>
  ),
}));

import AnaCareHoursPatientPage from './AnaCareHoursPatientPage';

describe('AnaCareHoursPatientPage', () => {
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

  it('POSITIVO — renderiza o container do detalhe com o patientId da URL; sem ?month usa o mês corrente e Volver o mantém', () => {
    mockUseParams.mockReturnValue({ patientId: '90000' });
    render(<AnaCareHoursPatientPage />);
    const stub = screen.getByTestId('stub-detail-container');
    expect(stub).toHaveAttribute('data-patient-id', '90000');
    expect(stub).toHaveAttribute('data-month', '2026-10');
    fireEvent.click(screen.getByTestId('stub-back'));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/anacare/horas?month=2026-10');
  });

  it('POSITIVO — ?month=2026-09 chega ao container e Volver devolve à lista NO MESMO mês', () => {
    mockUseParams.mockReturnValue({ patientId: '90000' });
    searchParamsRef.current = new URLSearchParams('month=2026-09');
    render(<AnaCareHoursPatientPage />);
    expect(screen.getByTestId('stub-detail-container')).toHaveAttribute('data-month', '2026-09');
    fireEvent.click(screen.getByTestId('stub-back'));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/anacare/horas?month=2026-09');
  });

  it('NEGATIVO — ?month inválido (abc, 2026-07, futuro) cai no mês corrente, sem erro', () => {
    mockUseParams.mockReturnValue({ patientId: '90000' });
    for (const raw of ['abc', '2026-07', '2026-11']) {
      searchParamsRef.current = new URLSearchParams(`month=${raw}`);
      const { unmount } = render(<AnaCareHoursPatientPage />);
      expect(screen.getByTestId('stub-detail-container')).toHaveAttribute('data-month', '2026-10');
      unmount();
    }
  });

  it('POSITIVO — a data selecionada mudar de mês grava ?month com replace (não empilha histórico)', () => {
    mockUseParams.mockReturnValue({ patientId: '90000' });
    render(<AnaCareHoursPatientPage />);
    fireEvent.click(screen.getByTestId('stub-month'));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ month: '2026-09' }, { replace: true });
  });

  it('NEGATIVO — sem patientId na URL não renderiza nada (null)', () => {
    mockUseParams.mockReturnValue({});
    const { container } = render(<AnaCareHoursPatientPage />);
    expect(container).toBeEmptyDOMElement();
  });
});
