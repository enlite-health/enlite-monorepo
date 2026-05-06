import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancySummaryCard } from '../VacancySummaryCard';
import type { VacancySummaryData } from '../VacancySummaryCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
    i18n: { language: 'es' },
  }),
}));

const BASE_DATA: VacancySummaryData = {
  caseNumber: 101,
  vacancyNumber: 3,
  patientFirstName: 'Juan',
  patientLastName: 'Pérez',
  status: 'BUSQUEDA',
  publishedAt: null,
  closedAt: null,
};

function renderCard(data: VacancySummaryData) {
  return render(<VacancySummaryCard data={data} />);
}

describe('VacancySummaryCard', () => {
  it('renders case title from caseNumber and vacancyNumber', () => {
    renderCard(BASE_DATA);
    expect(screen.getByText('CASO 101-3')).toBeInTheDocument();
  });

  it('renders patient full name', () => {
    renderCard(BASE_DATA);
    expect(screen.getByText(/Juan Pérez/)).toBeInTheDocument();
  });

  it('renders case number in the patient line', () => {
    renderCard(BASE_DATA);
    // Multiple elements may match /CASO 101/ — use getAllByText
    const matches = screen.getAllByText(/CASO 101/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders status badge text', () => {
    renderCard(BASE_DATA);
    expect(screen.getByText('BUSQUEDA')).toBeInTheDocument();
  });

  it('renders dash when publishedAt is null', () => {
    renderCard(BASE_DATA);
    const dashElements = screen.getAllByText(/—/);
    expect(dashElements.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render CASO title when caseNumber is null', () => {
    renderCard({ ...BASE_DATA, caseNumber: null, vacancyNumber: null });
    // "CASO 101-3" should not appear
    expect(screen.queryByText('CASO 101-3')).not.toBeInTheDocument();
  });

  it('renders formatted date substring when publishedAt is provided', () => {
    renderCard({ ...BASE_DATA, publishedAt: '2026-01-15T10:00:00Z' });
    // Should contain 15 (day part)
    expect(screen.getByText(/15/)).toBeInTheDocument();
  });
});
