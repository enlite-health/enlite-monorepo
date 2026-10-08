import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaseDetailsModal } from '../CaseDetailsModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('CaseDetailsModal', () => {
  const mockCaseData = {
    caseInfo: {
      case_number: 442,
      clickup_status: 'BUSQUEDA',
      clickup_priority: 'URGENTE',
      diagnosis: 'TEA',
      patient_zone: 'Palermo'
    },
    metrics: {
      postuladosInTalentum: 10,
      seleccionados: 2,
      reemplazos: 3,
      invitados: 8
    },
    publicationsHistory: [
      { channel: 'Facebook', published_at: '2024-01-15', recruiter_name: 'Admin' },
      { channel: 'Instagram', published_at: '2024-01-20', recruiter_name: 'Admin' }
    ]
  };

  it('should not render when isOpen is false', () => {
    const { container } = render(
      <CaseDetailsModal isOpen={false} onClose={vi.fn()} caseData={mockCaseData} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('should render when isOpen is true', () => {
    render(<CaseDetailsModal isOpen={true} onClose={vi.fn()} caseData={mockCaseData} />);

    expect(screen.getByText(/admin.recruitment.caseDetails/)).toBeInTheDocument();
    expect(screen.getByText(/442/)).toBeInTheDocument();
  });

  it('should display case information', () => {
    render(<CaseDetailsModal isOpen={true} onClose={vi.fn()} caseData={mockCaseData} />);

    expect(screen.getByText('BUSQUEDA')).toBeInTheDocument();
    expect(screen.getByText('URGENTE')).toBeInTheDocument();
    expect(screen.getByText('TEA')).toBeInTheDocument();
    expect(screen.getByText('Palermo')).toBeInTheDocument();
  });

  it('should display metrics', () => {
    render(<CaseDetailsModal isOpen={true} onClose={vi.fn()} caseData={mockCaseData} />);

    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('should display publications history', () => {
    render(<CaseDetailsModal isOpen={true} onClose={vi.fn()} caseData={mockCaseData} />);

    expect(screen.getByText('Facebook')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
  });

  it('should call onClose when close button is clicked', () => {
    const onCloseMock = vi.fn();
    render(<CaseDetailsModal isOpen={true} onClose={onCloseMock} caseData={mockCaseData} />);

    const closeButton = screen.getByRole('button', { name: /common.close/i });
    fireEvent.click(closeButton);

    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });

  it('should call onClose when clicking outside modal', () => {
    const onCloseMock = vi.fn();
    const { container } = render(
      <CaseDetailsModal isOpen={true} onClose={onCloseMock} caseData={mockCaseData} />
    );

    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);

    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });

  it('should not close when clicking inside modal content', () => {
    const onCloseMock = vi.fn();
    render(<CaseDetailsModal isOpen={true} onClose={onCloseMock} caseData={mockCaseData} />);

    const modalContent = screen.getByText('BUSQUEDA').closest('div');
    if (modalContent) {
      fireEvent.click(modalContent);
    }

    expect(onCloseMock).not.toHaveBeenCalled();
  });
});
