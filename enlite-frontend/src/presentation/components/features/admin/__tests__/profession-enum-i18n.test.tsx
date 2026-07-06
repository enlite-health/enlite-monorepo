/**
 * Visual proof: renders the admin components where a vacancy's required
 * profession is shown, using the REAL i18n config (real es/pt-BR resources),
 * and asserts that a vacancy with profession='CAREGIVER' displays the
 * translated label ("Cuidador/a") — not the raw enum "CAREGIVER".
 *
 * Regression reported by ops: the vacancy detail case card rendered
 * "CASO 798 - CAREGIVER - Indistinto - Sarandí" — the profession enum was
 * concatenated without going through i18n (sex already was).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { expectNoRawEnumLeaks } from '../../../../../test/rawEnumLeakGuard';
import { VacancyCaseCard } from '../VacancyDetail/VacancyCaseCard';
import { MatchCriteriaChips } from '../VacancyMatch/MatchCriteriaChips';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const caseProps = {
  status: 'SEARCHING',
  caseNumber: 798,
  dependencyLevel: null,
  profession: 'CAREGIVER',
  sex: 'BOTH',
  zone: 'Sarandí',
  patientCity: null,
  patientNeighborhood: null,
  paymentTermDays: null,
  netHourlyRate: null,
  weeklyHours: null,
  providersNeeded: null,
  publishedAt: null,
  closedAt: null,
};

const matchVacancy = {
  id: 'v1',
  required_sex: 'BOTH',
  required_professions: ['CAREGIVER'],
  patient_city: null,
  patient_neighborhood: null,
  patient_zone: null,
  city: null,
};

describe('Profession CAREGIVER → Cuidador/a (es)', () => {
  it('VacancyCaseCard: caseDesc shows "Cuidador/a" instead of "CAREGIVER"', () => {
    i18n.changeLanguage('es');
    const { container } = render(<VacancyCaseCard {...caseProps} />);
    expect(
      screen.getByText(/Cuidador\/a - Indistinto - Sarandí/),
    ).toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('MatchCriteriaChips: Profesión chip shows "Cuidador/a"', () => {
    i18n.changeLanguage('es');
    const { container } = render(
      <MatchCriteriaChips vacancy={matchVacancy as never} />,
    );
    expect(screen.getByText('Cuidador/a')).toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('unknown profession value falls back to the raw value (no crash, no empty)', () => {
    i18n.changeLanguage('es');
    render(<VacancyCaseCard {...caseProps} profession="ALGO_NUEVO" />);
    expect(
      screen.getByText(/ALGO_NUEVO - Indistinto - Sarandí/),
    ).toBeInTheDocument();
  });
});

describe('Profession CAREGIVER → Cuidador/a (pt-BR)', () => {
  it('VacancyCaseCard pt-BR also renders "Cuidador/a"', () => {
    i18n.changeLanguage('pt-BR');
    render(<VacancyCaseCard {...caseProps} />);
    expect(
      screen.getByText(/Cuidador\/a - Indistinto - Sarandí/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/CAREGIVER/)).not.toBeInTheDocument();
  });

  it('MatchCriteriaChips pt-BR also renders "Cuidador/a"', () => {
    i18n.changeLanguage('pt-BR');
    render(<MatchCriteriaChips vacancy={matchVacancy as never} />);
    expect(screen.getByText('Cuidador/a')).toBeInTheDocument();
  });
});
