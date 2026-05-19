/**
 * Visual proof — VacancyProfessionCard rendering with REAL i18n.
 *
 * Cobre os 4 campos do "Caso 774-784" reportado pela operação:
 *   - Tipo de servicio   → vem de patients.service_type (TEXT[]) → traduzido + joined
 *   - Días y Horarios    → vem de jp.schedule (normalizado pelo backend pra { lunes: [...] })
 *   - Localización       → vem de COALESCE(pa.neighborhood, p.zone_neighborhood) AS patient_zone
 *   - Faixa Etária       → quando NULL, exibe placeholder "Indistinto"
 *
 * Esse teste é a validação semântica de que, dado o response que o backend
 * corrigido devolve, o frontend renderiza os 4 valores na tela. Usa i18n REAL
 * (sem mock de `t`) para garantir que as chaves resolvem.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { VacancyProfessionCard } from '../VacancyProfessionCard';

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

const caso774Props = {
  profession: 'AT',
  requiredSex: 'F',
  diagnosis: null,
  talentumDescription: null,
  ageRangeMin: null,
  ageRangeMax: null,
  zone: 'Palermo',
  workerAttributes: 'AT mujer con experiencia con adultos jovenes con psicosis',
  serviceType: ['AT'],
  schedule: {
    lunes: [{ start: '10:30', end: '16:30' }],
    martes: [{ start: '10:30', end: '16:30' }],
    miercoles: [{ start: '10:30', end: '16:30' }],
    jueves: [{ start: '10:30', end: '16:30' }],
    viernes: [{ start: '10:30', end: '16:30' }],
  },
  onEdit: () => {},
};

describe('VacancyProfessionCard — render fields for CASO 774-784 shape', () => {
  it('renders translated serviceType from string[]', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...caso774Props} />);
    // 'AT' → traduzido para "Acompañante Terapéutico"
    expect(screen.getByText('Acompañante Terapéutico')).toBeInTheDocument();
  });

  it('renders Indistinto placeholder when both age_range_min and age_range_max are null', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...caso774Props} />);
    // Há 2 ocorrências esperadas: sex F (não casa) — só age range usa "Indistinto"
    // sex = 'F' → "Mujer", não conflita
    expect(screen.getByText('Indistinto')).toBeInTheDocument();
  });

  it('renders zone value when patient_zone is populated', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...caso774Props} />);
    expect(screen.getByText('Palermo')).toBeInTheDocument();
  });

  it('renders all 5 schedule pills (lunes through viernes) with normalized format', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...caso774Props} />);
    // O componente formata como "10:30h - 16:30h" (suffix 'h' + ' - ')
    const pills = screen.getAllByText('10:30h - 16:30h');
    expect(pills).toHaveLength(5);
  });

  it('renders worker attributes (profile field) — control case, already working', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...caso774Props} />);
    expect(
      screen.getByText('AT mujer con experiencia con adultos jovenes con psicosis'),
    ).toBeInTheDocument();
  });

  it('does NOT render schedule pills for días sin slots (sábado, domingo)', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...caso774Props} />);
    // sábado e domingo não têm slots
    // total de pills deve ser 5 (lunes a viernes)
    const allPills = screen.queryAllByText(/\d{2}:\d{2}h - \d{2}:\d{2}h/);
    expect(allPills).toHaveLength(5);
  });
});

describe('VacancyProfessionCard — degraded shape (CASO 774 sem zone)', () => {
  it('does not render Localización value when zone is null (label still shows)', () => {
    i18n.changeLanguage('es');
    render(<VacancyProfessionCard {...caso774Props} zone={null} />);
    // Label da Localización aparece, mas SEM valor preenchido (Palermo some)
    expect(screen.queryByText('Palermo')).not.toBeInTheDocument();
    expect(screen.getByText(/Localización/)).toBeInTheDocument();
  });
});
