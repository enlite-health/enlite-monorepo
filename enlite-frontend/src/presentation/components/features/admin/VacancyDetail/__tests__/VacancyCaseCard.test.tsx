import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyCaseCard } from '../VacancyCaseCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/components/atoms/VacancyStatusBadge', () => ({
  VacancyStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

const defaultProps = {
  status: 'BUSQUEDA',
  caseNumber: 748,
  dependencyLevel: 'Moderado',
  profession: 'AT',
  sex: 'M',
  zone: 'Palermo',
  patientCity: 'Buenos Aires',
  patientNeighborhood: 'Palermo',
  paymentTermDays: 30,
  netHourlyRate: 'R$8.000,00',
  weeklyHours: 30,
  providersNeeded: 2,
  publishedAt: '2026-02-25T00:00:00Z',
  closedAt: null,
};

function renderCard(props = {}) {
  return render(<VacancyCaseCard {...defaultProps} {...props} />);
}

// ── Render with full data ────────────────────────────────────────────────────

describe('VacancyCaseCard — full data', () => {
  it('renders status badge', () => {
    renderCard();
    expect(screen.getByTestId('status-badge')).toBeInTheDocument();
  });

  it('renders case number in heading', () => {
    renderCard();
    // getAllByText because the case number can appear in multiple elements
    const elements = screen.getAllByText(/748/);
    expect(elements.length).toBeGreaterThan(0);
  });

  it('renders dependency level pill', () => {
    renderCard();
    expect(screen.getByText('Moderado')).toBeInTheDocument();
  });

  it('renders net hourly rate value', () => {
    renderCard();
    expect(screen.getByText('R$8.000,00')).toBeInTheDocument();
  });

  it('renders weekly hours with h suffix', () => {
    renderCard();
    expect(screen.getByText('30h')).toBeInTheDocument();
  });

  it('renders providers needed value', () => {
    renderCard();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders location city and neighborhood', () => {
    renderCard();
    expect(
      screen.getByText('Buenos Aires, Palermo'),
    ).toBeInTheDocument();
  });

  it('renders payment term section heading', () => {
    renderCard();
    expect(
      screen.getByText('admin.vacancyDetail.caseCard.paymentTerm'),
    ).toBeInTheDocument();
  });

  it('renders dates section heading', () => {
    renderCard();
    expect(
      screen.getByText('admin.vacancyDetail.caseCard.dates'),
    ).toBeInTheDocument();
  });
});

// ── Partial/null data ────────────────────────────────────────────────────────

describe('VacancyCaseCard — partial data (missing optional fields)', () => {
  it('renders em dash when netHourlyRate is null', () => {
    renderCard({ netHourlyRate: null });
    // at least one — should appear
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('renders em dash when weeklyHours is null', () => {
    renderCard({ weeklyHours: null });
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('does NOT render dependency pill when dependencyLevel is null', () => {
    renderCard({ dependencyLevel: null });
    expect(screen.queryByText('Moderado')).not.toBeInTheDocument();
  });

  it('does NOT render location row when patientCity and patientNeighborhood are null', () => {
    renderCard({ patientCity: null, patientNeighborhood: null });
    expect(screen.queryByText(/Buenos Aires/)).not.toBeInTheDocument();
  });
});
