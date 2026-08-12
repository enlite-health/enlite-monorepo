/**
 * Visual proof: renders the 3 admin components where `required_sex` is shown,
 * using the REAL i18n config (with real es/pt-BR resources), and asserts that
 * a vacancy with `required_sex='BOTH'` displays "Indistinto" — not "BOTH" raw.
 *
 * This was the regression reported by ops: in some admin views the literal
 * value "BOTH" was leaking through because the value was rendered without
 * going through i18n.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { expectNoRawEnumLeaks } from '../../../../../test/rawEnumLeakGuard';
import { VacancyCaseCard } from '../VacancyDetail/VacancyCaseCard';
import { VacancyProfessionCard } from '../VacancyDetail/VacancyProfessionCard';
import { MatchCriteriaChips } from '../VacancyMatch/MatchCriteriaChips';

beforeAll(async () => {
  // Re-init i18n with the REAL locale resources so translation keys resolve to actual strings.
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
  status: 'BUSQUEDA',
  caseNumber: 999,
  dependencyLevel: null,
  profession: 'AT',
  sex: 'BOTH',
  zone: 'Palermo',
  patientCity: null,
  patientNeighborhood: null,
  paymentTermDays: null,
  netHourlyRate: null,
  weeklyHours: null,
  providersNeeded: null,
  publishedAt: null,
  closedAt: null,
};

const professionProps = {
  profession: 'AT',
  requiredSex: 'BOTH',
  diagnosis: null,
  talentumDescription: null,
  ageRangeMin: null,
  ageRangeMax: null,
  zone: null,
  workerAttributes: null,
  serviceType: null,
  schedule: null,
  onEdit: () => {},
};

const matchVacancy = {
  id: 'v1',
  required_sex: 'BOTH',
  required_professions: ['AT'],
  patient_city: null,
  patient_neighborhood: null,
  patient_zone: null,
  city: null,
};

describe('Sex BOTH → Indistinto (es)', () => {
  it('VacancyCaseCard: caseParts shows "Indistinto" instead of "BOTH"', () => {
    i18n.changeLanguage('es');
    render(<VacancyCaseCard {...caseProps} />);
    // caseParts joins profession (translated) + sex + zone
    expect(
      screen.getByText(/Acompañante Terapéutico - Indistinto - Palermo/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/BOTH/)).not.toBeInTheDocument();
  });

  it('VacancyProfessionCard: availableFor row shows "Indistinto"', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...professionProps} />);
    // Both sex (BOTH → Indistinto) and age range placeholder (ageRangeAny → Indistinto) render
    // the same label — what we care about here is that no raw "BOTH" leaks through.
    expect(screen.getAllByText('Indistinto').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^BOTH$/)).not.toBeInTheDocument();
  });

  it('MatchCriteriaChips: Sexo chip shows "Indistinto"', () => {
    i18n.changeLanguage('es');
    const { container } = render(
      <MatchCriteriaChips vacancy={matchVacancy as never} />,
    );
    expect(screen.getByText('Indistinto')).toBeInTheDocument();
    expect(screen.queryByText(/^BOTH$/)).not.toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });
});

describe('Sex BOTH → Indistinto (pt-BR)', () => {
  it('VacancyCaseCard pt-BR also renders "Indistinto"', () => {
    i18n.changeLanguage('pt-BR');
    render(<VacancyCaseCard {...caseProps} />);
    expect(
      screen.getByText(/Acompanhante Terapêutico - Indistinto - Palermo/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/BOTH/)).not.toBeInTheDocument();
  });

  it('VacancyProfessionCard pt-BR also renders "Indistinto"', () => {
    i18n.changeLanguage('pt-BR');
    render(<VacancyProfessionCard {...professionProps} />);
    expect(screen.getAllByText('Indistinto').length).toBeGreaterThan(0);
  });

  it('MatchCriteriaChips pt-BR also renders "Indistinto"', () => {
    i18n.changeLanguage('pt-BR');
    render(
      <MemoryRouter>
        <MatchCriteriaChips vacancy={matchVacancy as never} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Indistinto')).toBeInTheDocument();
  });
});
