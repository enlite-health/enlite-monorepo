import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyPatientCard } from '../VacancyPatientCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ── Rendering ────────────────────────────────────────────────────────────────

describe('VacancyPatientCard — rendering', () => {
  it('renders card title with i18n key', () => {
    render(<VacancyPatientCard firstName="Juan" lastName="Perez" />);
    expect(
      screen.getByText('admin.vacancyDetail.patientCard.title'),
    ).toBeInTheDocument();
  });

  it('renders name label with i18n key', () => {
    render(<VacancyPatientCard firstName="Juan" lastName="Perez" />);
    expect(
      screen.getByText('admin.vacancyDetail.patientCard.nameLabel'),
    ).toBeInTheDocument();
  });

  it('renders full patient name', () => {
    render(<VacancyPatientCard firstName="Juan" lastName="Perez" />);
    expect(screen.getByText('Juan Perez')).toBeInTheDocument();
  });

  it('renders em dash when both names are null', () => {
    render(<VacancyPatientCard firstName={null} lastName={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders only first name when last name is null', () => {
    render(<VacancyPatientCard firstName="Juan" lastName={null} />);
    expect(screen.getByText('Juan')).toBeInTheDocument();
  });

  it('renders Eye icon', () => {
    const { container } = render(
      <VacancyPatientCard firstName="Juan" lastName="Perez" />,
    );
    // lucide renders an svg
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
