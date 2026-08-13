/**
 * TDD red-first: `VacancyDetailsCard` (public vacancy page) must render
 * Patología and Tipo de dispositivo (missing before this fix), and always
 * show the "Rango Etario" row — falling back to "Indistinta" when both
 * bounds are null instead of hiding the row.
 *
 * Regression class this guards against: `service_type` is a backend enum
 * with the FULL profession vocabulary — `AT | CAREGIVER | NURSE |
 * KINESIOLOGIST | PSYCHOLOGIST` (see worker-functions
 * src/modules/worker/domain/enums/Profession.ts; the ClickUp serviceMap
 * can produce any of the 5) — and must never leak raw in the DOM. See
 * enlite-frontend/CLAUDE.md (i18n) and `sex-both-i18n.test.tsx` for the
 * established pattern (real i18n resources + rawEnumLeakGuard).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { PublicVacancyDetail } from '@domain/entities/Vacancy';

import { expectNoRawEnumLeaks } from '../../../../test/rawEnumLeakGuard';
import { VacancyDetailsCard } from '../PublicVacancyPage';

beforeAll(async () => {
  // Re-init i18n with the REAL locale resources so translation keys resolve
  // to actual strings (not just the key path).
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

const baseVacancy: PublicVacancyDetail = {
  id: 'v1',
  case_number: 797,
  vacancy_number: 2208,
  title: 'CASO 797-2208',
  status: 'BUSQUEDA',
  required_professions: ['AT'],
  required_sex: 'BOTH',
  age_range_min: null,
  age_range_max: null,
  worker_attributes: 'Se busca un/a AT con experiencia en trastornos del ánimo.',
  schedule: { lunes: [{ start: '09:00', end: '13:00' }] },
  schedule_days_hours: null,
  salary_text: null,
  talentum_description: 'Buscamos un/a Acompañante Terapéutico para paciente adulto.',
  talentum_whatsapp_url: 'https://wa.me/5491112345678',
  patient_zone: 'Villa Ballester, Buenos Aires',
  country: 'Argentina',
  created_at: '2026-01-01T00:00:00Z',
  pathologies: 'Trastorno Bipolar,\ncomórbido con TDAH y TEA',
  service_type: ['AT'],
};

describe('VacancyDetailsCard — campos faltantes (es)', () => {
  it('renderiza Patología (diagnosticHypothesis) com o texto livre, preservando quebras de linha', () => {
    i18n.changeLanguage('es');
    const { container } = render(<VacancyDetailsCard vacancy={baseVacancy} />);
    expect(screen.getByText('Hipótesis Diagnóstica - CIE:')).toBeInTheDocument();
    expect(screen.getByText(/Trastorno Bipolar/)).toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('traduz service_type AT para "Acompañante Terapéutico" (nunca "AT" cru)', () => {
    i18n.changeLanguage('es');
    render(<VacancyDetailsCard vacancy={baseVacancy} />);
    expect(screen.getByText('Tipo de servicio:')).toBeInTheDocument();
    expect(screen.getByText('Acompañante Terapéutico')).toBeInTheDocument();
  });

  it('mostra "Indistinta" quando age_range_min e age_range_max são null (linha nunca some)', () => {
    i18n.changeLanguage('es');
    render(<VacancyDetailsCard vacancy={baseVacancy} />);
    expect(screen.getByText('Rango Etario:')).toBeInTheDocument();
    expect(screen.getByText('Indistinta')).toBeInTheDocument();
  });

  it('mantém o formato "min - max" quando os dois limites existem', () => {
    i18n.changeLanguage('es');
    render(
      <VacancyDetailsCard
        vacancy={{ ...baseVacancy, age_range_min: 25, age_range_max: 60 }}
      />,
    );
    expect(screen.getByText('25 - 60')).toBeInTheDocument();
    expect(screen.queryByText('Indistinta')).not.toBeInTheDocument();
  });

  it('mostra "Desde {min} años" quando só age_range_min existe (nunca mostra o número pelado)', () => {
    i18n.changeLanguage('es');
    render(
      <VacancyDetailsCard vacancy={{ ...baseVacancy, age_range_min: 18, age_range_max: null }} />,
    );
    expect(screen.getByText('Desde 18 años')).toBeInTheDocument();
    expect(screen.queryByText('18')).not.toBeInTheDocument();
  });

  it('mostra "Hasta {max} años" quando só age_range_max existe (nunca mostra o número pelado)', () => {
    i18n.changeLanguage('es');
    render(
      <VacancyDetailsCard vacancy={{ ...baseVacancy, age_range_min: null, age_range_max: 65 }} />,
    );
    expect(screen.getByText('Hasta 65 años')).toBeInTheDocument();
    expect(screen.queryByText('65')).not.toBeInTheDocument();
  });

  it('traduz service_type CAREGIVER e o guard detecta se algum enum vazar cru', () => {
    i18n.changeLanguage('es');
    const { container } = render(
      <VacancyDetailsCard vacancy={{ ...baseVacancy, service_type: ['CAREGIVER'] }} />,
    );
    expect(screen.getByText('Cuidador')).toBeInTheDocument();
    expect(screen.queryByText(/^CAREGIVER$/)).not.toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('BLOCKER: traduz service_type PSYCHOLOGIST — nunca deixa o enum cru vazar', () => {
    i18n.changeLanguage('es');
    const { container } = render(
      <VacancyDetailsCard vacancy={{ ...baseVacancy, service_type: ['PSYCHOLOGIST'] }} />,
    );
    expect(screen.getByText('Psicólogo/a')).toBeInTheDocument();
    expect(screen.queryByText(/^PSYCHOLOGIST$/)).not.toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('BLOCKER: traduz service_type NURSE e KINESIOLOGIST — nunca deixa o enum cru vazar', () => {
    i18n.changeLanguage('es');
    const { container: nurseContainer } = render(
      <VacancyDetailsCard vacancy={{ ...baseVacancy, service_type: ['NURSE'] }} />,
    );
    expect(screen.getByText('Enfermero/a')).toBeInTheDocument();
    expectNoRawEnumLeaks(nurseContainer);

    const { container: kineContainer } = render(
      <VacancyDetailsCard vacancy={{ ...baseVacancy, service_type: ['KINESIOLOGIST'] }} />,
    );
    expect(screen.getByText('Kinesiólogo/a')).toBeInTheDocument();
    expectNoRawEnumLeaks(kineContainer);
  });

  it('junta múltiplos service_type traduzidos com vírgula (ex: AT + CAREGIVER)', () => {
    i18n.changeLanguage('es');
    const { container } = render(
      <VacancyDetailsCard vacancy={{ ...baseVacancy, service_type: ['AT', 'CAREGIVER'] }} />,
    );
    expect(screen.getByText('Acompañante Terapéutico, Cuidador')).toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('não renderiza a seção de patología quando pathologies é ausente', () => {
    i18n.changeLanguage('es');
    render(<VacancyDetailsCard vacancy={{ ...baseVacancy, pathologies: null }} />);
    expect(screen.queryByText('Hipótesis Diagnóstica - CIE:')).not.toBeInTheDocument();
  });
});

describe('VacancyDetailsCard — campos faltantes (pt-BR)', () => {
  it('traduz service_type AT e mostra "Indistinta" em pt-BR', () => {
    i18n.changeLanguage('pt-BR');
    const { container } = render(<VacancyDetailsCard vacancy={baseVacancy} />);
    expect(screen.getByText('Acompanhante Terapêutico')).toBeInTheDocument();
    expect(screen.getByText('Indistinta')).toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });
});
