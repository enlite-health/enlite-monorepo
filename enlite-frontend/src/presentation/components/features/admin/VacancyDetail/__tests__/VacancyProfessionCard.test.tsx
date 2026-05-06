import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyProfessionCard } from '../VacancyProfessionCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const defaultProps = {
  profession: 'AT',
  requiredSex: 'Femenino',
  diagnosis: 'TEA',
  talentumDescription: null,
  ageRangeMin: 25,
  ageRangeMax: 45,
  zone: 'Palermo',
  workerAttributes: 'Paciente, empático',
  serviceType: 'DOMICILIARIO',
  schedule: null,
  onEdit: vi.fn(),
};

function renderCard(props = {}) {
  return render(<VacancyProfessionCard {...defaultProps} {...props} />);
}

// ── Title variants ───────────────────────────────────────────────────────────

describe('VacancyProfessionCard — title', () => {
  it('renders AT title for profession AT', () => {
    renderCard({ profession: 'AT' });
    expect(
      screen.getByText('admin.vacancyDetail.professionCard.title'),
    ).toBeInTheDocument();
  });

  it('renders caregiver title for profession CAREGIVER', () => {
    renderCard({ profession: 'CAREGIVER' });
    expect(
      screen.getByText('admin.vacancyDetail.professionCard.titleCaregiver'),
    ).toBeInTheDocument();
  });

  it('is case-insensitive for caregiver detection', () => {
    renderCard({ profession: 'caregiver' });
    expect(
      screen.getByText('admin.vacancyDetail.professionCard.titleCaregiver'),
    ).toBeInTheDocument();
  });
});

// ── Fields ───────────────────────────────────────────────────────────────────

describe('VacancyProfessionCard — fields', () => {
  it('renders availableFor label', () => {
    renderCard();
    expect(
      screen.getByText('admin.vacancyDetail.professionCard.availableFor'),
    ).toBeInTheDocument();
  });

  it('renders requiredSex value', () => {
    renderCard();
    expect(screen.getByText('Femenino')).toBeInTheDocument();
  });

  it('renders diagnosis value', () => {
    renderCard();
    expect(screen.getByText('TEA')).toBeInTheDocument();
  });

  it('renders age range when both min and max provided', () => {
    renderCard();
    expect(screen.getByText('25 - 45')).toBeInTheDocument();
  });

  it('does NOT render description section when talentumDescription is null', () => {
    renderCard({ talentumDescription: null });
    expect(
      screen.queryByText('admin.vacancyDetail.professionCard.description'),
    ).not.toBeInTheDocument();
  });

  it('renders description when talentumDescription is provided', () => {
    renderCard({ talentumDescription: 'Se busca AT con experiencia en TEA.' });
    expect(
      screen.getByText('Se busca AT con experiencia en TEA.'),
    ).toBeInTheDocument();
  });

  it('renders Editar button', () => {
    renderCard();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });
});

// ── Schedule grid ────────────────────────────────────────────────────────────

describe('VacancyProfessionCard — schedule grid', () => {
  it('renders all 7 weekday labels', () => {
    renderCard();
    expect(
      screen.getByText(
        'admin.vacancyDetail.professionCard.weekdays.sunday',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'admin.vacancyDetail.professionCard.weekdays.saturday',
      ),
    ).toBeInTheDocument();
  });

  it('renders schedule pills when schedule data is provided', () => {
    renderCard({
      schedule: {
        monday: [{ start: '09:00', end: '13:00' }],
      },
    });
    expect(screen.getByText('09:00h - 13:00h')).toBeInTheDocument();
  });

  it('renders no pills when schedule is null', () => {
    renderCard({ schedule: null });
    // pills have specific text pattern
    expect(screen.queryByText(/h - /)).not.toBeInTheDocument();
  });
});
