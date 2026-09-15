import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate, mockUseParams } = vi.hoisted(() => ({ mockNavigate: vi.fn(), mockUseParams: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate, useParams: () => mockUseParams() }));

vi.mock('@presentation/components/features/admin/AnaCareHours/AnaCareHoursDetailContainer', () => ({
  AnaCareHoursDetailContainer: ({ onBack, patientId }: { onBack: () => void; patientId: string }) => (
    <button data-testid="stub-detail-container" data-patient-id={patientId} onClick={onBack}>
      stub
    </button>
  ),
}));

import AnaCareHoursPatientPage from './AnaCareHoursPatientPage';

describe('AnaCareHoursPatientPage', () => {
  it('POSITIVO — renderiza o container do detalhe com o patientId da URL e volta pela lista ao onBack', () => {
    mockUseParams.mockReturnValue({ patientId: '90000' });
    render(<AnaCareHoursPatientPage />);
    const stub = screen.getByTestId('stub-detail-container');
    expect(stub).toHaveAttribute('data-patient-id', '90000');
    fireEvent.click(stub);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/anacare/horas');
  });

  it('NEGATIVO — sem patientId na URL não renderiza nada (null)', () => {
    mockUseParams.mockReturnValue({});
    const { container } = render(<AnaCareHoursPatientPage />);
    expect(container).toBeEmptyDOMElement();
  });
});
